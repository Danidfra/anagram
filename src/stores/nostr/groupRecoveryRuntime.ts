import NostrClient, {
  ClientEvent,
  NostrPrivateKeySigner,
  NostrUser,
} from '#src/lib/nostr/client.ts';
import { contactsService } from '#src/services/contactsService.ts';
import type { GroupIdentitySecretContent, RelayPublishStatusesResult } from './types.ts';
import {
  deriveGroupIdentityKey,
  deriveGroupEpochKey,
  groupEntropyFromPhrase,
  groupPhraseFromEntropy,
  GROUP_RECOVERY_TAG,
  GENESIS_REVISION,
  newGroupRevision,
  normalizeRecoveryState,
  recoveryHeads,
  safeRecoveryMembers,
  type GroupRecoveryState,
  type GroupRecoveryRecord,
} from './groupRecovery.ts';

interface Dependencies {
  ndk: NostrClient;
  account: () => string | null;
  connect: (relays: string[]) => Promise<void>;
  encrypt: (secret: GroupIdentitySecretContent) => Promise<string>;
  decrypt: (ciphertext: string) => Promise<GroupIdentitySecretContent | null>;
  saveContact: (
    key: string,
    ciphertext: string,
    profile: { name?: string; about?: string },
  ) => Promise<boolean>;
  persistEpoch: (
    group: string,
    epoch: number,
    key: string,
    options?: {
      accepted?: boolean;
      fallbackName?: string;
      seedRelayUrls?: string[];
      invitationCreatedAt?: string;
      allowRecoveryFork?: boolean;
    },
  ) => Promise<void>;
  publish: (
    event: ClientEvent,
    relays: string[],
    scope?: 'recipient' | 'self',
  ) => Promise<RelayPublishStatusesResult>;
  publishAccountBackup: (key: string, ciphertext: string, relays: string[]) => Promise<unknown>;
  changed: () => void;
  defaultRelays: () => string[];
}

export function createGroupRecoveryRuntime(d: Dependencies) {
  const pending = new Map<string, Promise<unknown>>();
  // Contact/profile hydration may replay an older encrypted account snapshot.
  // Keep the locally verified journal baseline separately (never cache the master).
  const installed = new Map<string, GroupRecoveryRecord>();
  let installedAccount: string | null = null;
  function session() {
    const account = d.account();
    if (!account) throw new Error('Sign in before managing a group.');
    if (installedAccount !== account) {
      installed.clear();
      installedAccount = account;
    }
    return () => {
      if (d.account() !== account) throw new Error('The active account changed. Reopen the group.');
    };
  }
  async function exclusive<T>(group: string, action: () => Promise<T>): Promise<T> {
    const key = `${d.account()}:${group}`;
    if (pending.has(key)) throw new Error('A group update is already running. Please wait.');
    const task = (async () => {
      // Web Locks also serialize tabs. Other devices use the authenticated revision check.
      if (typeof navigator !== 'undefined' && navigator.locks) {
        return navigator.locks.request(`anagram:group:${key}`, action);
      }
      return action();
    })();
    pending.set(key, task);
    try {
      return await task;
    } finally {
      if (pending.get(key) === task) pending.delete(key);
    }
  }
  function relays(values: string[]): string[] {
    const urls = [
      ...new Set(
        values.map((value) => {
          const url = new URL(value);
          if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password)
            throw new Error('Invalid recovery relay URL.');
          return url.href;
        }),
      ),
    ];
    if (!urls.length || urls.length > 32)
      throw new Error('Choose between one and 32 group recovery relays.');
    return urls;
  }
  async function secretFor(group: string) {
    const check = session();
    const contact = await contactsService.getContactByPublicKey(group);
    const secret = contact?.meta.group_private_key_encrypted
      ? await d.decrypt(contact.meta.group_private_key_encrypted)
      : null;
    check();
    if (
      !secret?.recovery_entropy ||
      new NostrPrivateKeySigner(deriveGroupIdentityKey(secret.recovery_entropy)).pubkey !== group
    ) {
      throw new Error('Import this group’s recovery phrase to manage it.');
    }
    const record = installed.get(group);
    return record ? secretFromState(secret.recovery_entropy, record) : secret;
  }
  // A timeout/closed socket is not EOSE. Management reads must cover every
  // configured journal relay; otherwise a newer removal could be missed.
  async function page(
    group: string,
    relay: string,
    until: number | undefined,
    limit: number,
    probeId?: string,
  ) {
    return new Promise<ClientEvent[]>((resolve, reject) => {
      const events = new Map<string, ClientEvent>();
      const sub = d.ndk.subscribe(
        {
          kinds: [30078],
          authors: [group],
          ...(probeId ? { ids: [probeId] } : { '#t': [GROUP_RECOVERY_TAG] }),
          limit,
          ...(until === undefined ? {} : { until }),
        },
        { relayUrls: [relay], closeOnEose: true },
        undefined,
        false,
      );
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.stop();
        if (error) reject(error);
        else resolve([...events.values()]);
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              'A group recovery relay did not finish responding. Retry when it is available.',
            ),
          ),
        12000,
      );
      sub.on('event', (event: ClientEvent) => {
        if (
          event.pubkey === group &&
          event.kind === 30078 &&
          event.verifySignature() &&
          (probeId
            ? event.id === probeId
            : event.tags.some((t) => t[0] === 't' && t[1] === GROUP_RECOVERY_TAG))
        )
          events.set(event.id, event);
      });
      sub.on('eose', () => finish());
      sub.on('closed', () =>
        finish(
          new Error('A group recovery relay is unavailable. No membership changes were made.'),
        ),
      );
      sub.start();
    });
  }
  async function fetchRecords(
    entropy: string,
    urls: string[],
    requireAll = true,
    completed?: Set<string>,
  ) {
    const check = session();
    const signer = new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy), d.ndk);
    await d.connect(relays(urls));
    check();
    const events = new Map<string, ClientEvent>();
    const results = await Promise.allSettled(
      relays(urls).map(async (relay) => {
        let until: number | undefined;
        let limit = 128;
        const seen = new Set<string>();
        for (;;) {
          check();
          let batch: ClientEvent[];
          for (let attempt = 0; ; attempt++) {
            try {
              batch = await page(signer.pubkey, relay, until, limit);
              break;
            } catch (error) {
              if (
                attempt >= 2 ||
                !(error instanceof Error) ||
                !error.message.includes('relay is unavailable')
              )
                throw error;
              // A user retry can race the socket's close notification. Give the
              // existing connection guard a chance to reconnect; never infer EOSE.
              await new Promise((resolve) => setTimeout(resolve, attempt ? 1000 : 250));
              check();
            }
          }
          check();
          let fresh = 0;
          for (const event of batch) {
            if (!seen.has(event.id)) fresh++;
            seen.add(event.id);
            events.set(event.id, event);
          }
          if (batch.length < limit) break;
          const oldest = Math.min(...batch.map((e) => e.created_at));
          if (oldest === until || fresh === 0) {
            if (limit >= 8192)
              throw new Error(
                'Too many group updates at the same timestamp. Recovery cannot establish complete history.',
              );
            limit *= 2;
          } else {
            until = oldest;
            limit = 128;
          }
        }
        completed?.add(relay);
      }),
    );
    check();
    if (
      (requireAll && results.some((r) => r.status === 'rejected')) ||
      results.every((r) => r.status === 'rejected')
    ) {
      throw new Error(
        requireAll
          ? 'Could not verify group state on its recovery relays. Retry before changing membership.'
          : 'No relay completed the group recovery check. Check your relay connections and try again.',
      );
    }
    const records: GroupRecoveryRecord[] = [];
    for (const event of events.values()) {
      const content = await signer.decrypt(
        new NostrUser({ pubkey: signer.pubkey }),
        event.content,
        'nip44',
      );
      check();
      const state = normalizeRecoveryState(JSON.parse(content));
      if (
        event.tags.filter((t) => t[0] === 'd').length !== 1 ||
        event.tags.find((t) => t[0] === 'd')?.[1] !== `${GROUP_RECOVERY_TAG}:${state.revision}`
      ) {
        throw new Error('Invalid signed group recovery record.');
      }
      records.push({ id: event.id, state, event: event.rawEvent() });
    }
    recoveryHeads(records); // Verify parent closure, even for a read-only restore.
    return records;
  }
  async function readJournal(entropy: string, initial: string[], requireInitial = true) {
    let records = await fetchRecords(entropy, initial, requireInitial);
    // Old backup files and account snapshots can point several moves behind.
    // Preserve every observed branch while following signed relay pointers.
    const visited = new Set<string>();
    for (let hop = 0; hop < 32; hop++) {
      const urls = [...new Set(recoveryHeads(records).flatMap((r) => r.state.relays))].sort();
      if (!urls.length) return records;
      const key = JSON.stringify(urls);
      if (visited.has(key)) return records;
      visited.add(key);
      const next = await fetchRecords(entropy, urls);
      records = [...new Map([...records, ...next].map((record) => [record.id, record])).values()];
    }
    throw new Error('Too many group relay changes to verify safely. Use a recent recovery backup.');
  }
  async function publishState(
    entropy: string,
    state: GroupRecoveryState,
    additionalRelays: string[] = [],
  ): Promise<GroupRecoveryRecord> {
    const check = session();
    normalizeRecoveryState(state);
    const signer = new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy), d.ndk);
    const event = new ClientEvent(d.ndk, {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: signer.pubkey,
      tags: [
        ['d', `${GROUP_RECOVERY_TAG}:${state.revision}`],
        ['t', GROUP_RECOVERY_TAG],
      ],
      content: await signer.encrypt(
        new NostrUser({ pubkey: signer.pubkey }),
        JSON.stringify(state),
        'nip44',
      ),
    });
    check();
    await event.sign(signer);
    const targets = relays([...state.relays, ...additionalRelays]);
    const result = await d.publish(event, targets, 'self');
    check();
    const accepted = new Set(
      result.relayStatuses
        .filter((s) => s.status === 'published')
        .map((s) => new URL(s.relay_url).href),
    );
    if (targets.some((r) => !accepted.has(new URL(r).href))) {
      throw new Error(
        'The group update has not reached every recovery relay. Refresh group recovery before retrying; invitations were not sent.',
      );
    }
    return { id: event.id, state, event: event.rawEvent() };
  }
  function secretFromState(
    entropy: string,
    record: GroupRecoveryRecord,
  ): GroupIdentitySecretContent {
    const groupKey = deriveGroupIdentityKey(entropy);
    return {
      version: 2,
      group_pubkey: new NostrPrivateKeySigner(groupKey).pubkey,
      group_privkey: groupKey,
      recovery_entropy: entropy,
      recovery_state_id: record.id,
      recovery_state: record.state,
      epoch_number: record.state.epoch,
      epoch_privkey: deriveGroupEpochKey(entropy, record.state.epoch, record.state.epoch_revision),
      name: record.state.name,
      about: record.state.about,
    };
  }
  async function install(
    entropy: string,
    record: GroupRecoveryRecord,
    historical: GroupRecoveryRecord[] = [],
  ) {
    const check = session();
    const secret = secretFromState(entropy, record);
    const ciphertext = await d.encrypt(secret);
    check();
    await d.saveContact(secret.group_pubkey, ciphertext, secret);
    check();
    installed.set(secret.group_pubkey, record);
    const contact = await contactsService.getContactByPublicKey(secret.group_pubkey);
    if (contact)
      await contactsService.updateContact(contact.id, {
        relays: record.state.relays.map((url) => ({ url, read: true, write: true })),
        meta: {
          ...contact.meta,
          group_members: record.state.members
            .filter((p) => p !== d.account())
            .map((public_key) => ({ public_key, name: '', given_name: '', picture: '' })),
        },
      });
    // Install newest first; the existing history runtime pages each recipient.
    for (const entry of [
      record,
      ...historical.filter((r) => r.id !== record.id).sort((a, b) => b.state.epoch - a.state.epoch),
    ]) {
      check();
      await d.persistEpoch(
        secret.group_pubkey,
        entry.state.epoch,
        deriveGroupEpochKey(entropy, entry.state.epoch, entry.state.epoch_revision),
        {
          accepted: true,
          fallbackName: secret.name,
          seedRelayUrls: entry.state.relays,
          allowRecoveryFork: true,
        },
      );
    }
    check();
    d.changed();
    // Encrypted account backup is a convenience. The group recovery journal is authoritative.
    await d.publishAccountBackup(secret.group_pubkey, ciphertext, record.state.relays);
    check();
    return secret;
  }
  async function selectCreationRelays(entropy: string, candidates: string[]) {
    const check = session();
    const readable = new Set<string>();
    const existing = await fetchRecords(entropy, candidates, false, readable);
    if (existing.length)
      throw new Error('This recovery phrase already belongs to a group. Use Restore group.');
    // A relay may permit reading but reject group-authored NIP-78 writes.
    // Probe outside the journal before fixing the group's authoritative relay set.
    const signer = new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy), d.ndk);
    const probe = new ClientEvent(d.ndk, {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: signer.pubkey,
      tags: [
        ['d', `${GROUP_RECOVERY_TAG}:relay-check`],
        ['t', `${GROUP_RECOVERY_TAG}-relay-check`],
      ],
      content: await signer.encrypt(
        new NostrUser({ pubkey: signer.pubkey }),
        'Group recovery relay check',
        'nip44',
      ),
    });
    check();
    await probe.sign(signer);
    const result = await d.publish(probe, [...readable], 'self');
    check();
    const accepted = new Set(
      result.relayStatuses
        .filter((status) => status.status === 'published')
        .map((status) => new URL(status.relay_url).href),
    );
    const verified = await Promise.allSettled(
      [...readable]
        .filter((url) => accepted.has(url))
        .map(async (url) => {
          const stored = await page(signer.pubkey, url, undefined, 1, probe.id);
          check();
          if (!stored.some((event) => event.id === probe.id))
            throw new Error('Relay did not retain the recovery check.');
          return url;
        }),
    );
    check();
    const selected = verified.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (!selected.length)
      throw new Error(
        'None of your available relays could store and return group recovery records. Check your relays and try again.',
      );
    return selected;
  }
  async function create(phrase: string, name: string, about: string, relayUrls: string[]) {
    const entropy = groupEntropyFromPhrase(phrase);
    const group = new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy)).pubkey;
    return exclusive(group, async () => {
      const urls = await selectCreationRelays(entropy, relays(relayUrls));
      const state: GroupRecoveryState = {
        version: 1,
        revision: GENESIS_REVISION,
        epoch_revision: GENESIS_REVISION,
        epoch: 0,
        parents: [],
        members: [d.account()!],
        owners: [d.account()!],
        relays: urls,
        name,
        about,
      };
      const record = await publishState(entropy, state);
      return install(entropy, record);
    });
  }
  async function inspect(phrase: string, relayUrls: string[] = []) {
    const entropy = groupEntropyFromPhrase(phrase);
    const initial = relays(relayUrls.length ? relayUrls : d.defaultRelays());
    const check = session();
    const group = new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy)).pubkey;
    const advertised = await d.ndk.fetchEvents(
      { kinds: [10002, 10050], authors: [group] },
      { relayUrls: initial },
    );
    check();
    const discovered = [...advertised]
      .filter((event) => event.pubkey === group && event.verifySignature())
      .flatMap((event) =>
        event.tags.filter((tag) => tag[0] === 'r' || tag[0] === 'relay').map((tag) => tag[1]),
      )
      .filter((url) => {
        try {
          const u = new URL(url);
          return ['ws:', 'wss:'].includes(u.protocol) && !u.username && !u.password;
        } catch {
          return false;
        }
      });
    const records = await readJournal(
      entropy,
      [...new Set([...initial, ...discovered])].slice(0, 32),
      false,
    );
    if (!records.length)
      throw new Error(
        'No group recovery records found. Add the original group relay or import its recovery file.',
      );
    const heads = recoveryHeads(records);
    if (!heads.length) throw new Error('Group recovery history is unavailable.');
    return {
      entropy,
      records,
      heads,
      group: new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy)).pubkey,
    };
  }
  async function restore(phrase: string, relayUrls: string[] = []) {
    const found = await inspect(phrase, relayUrls);
    return exclusive(found.group, async () => {
      const secret = await install(found.entropy, found.heads[0], found.records);
      if (found.heads.length === 1 && !secret.recovery_state!.owners.includes(d.account()!)) {
        return update(found.group, secret.recovery_state!.members);
      }
      return secret;
    });
  }
  async function update(
    group: string,
    members: string[],
    reconcile = false,
    forceRotation = false,
  ) {
    const secret = await secretFor(group);
    if (!secret.recovery_state || !secret.recovery_state_id)
      throw new Error('Restore the group recovery state first.');
    const records = await readJournal(secret.recovery_entropy!, secret.recovery_state.relays);
    const heads = recoveryHeads(records);
    if (!heads.length) throw new Error('Group recovery state is missing.');
    if (!reconcile && (heads.length !== 1 || heads[0].id !== secret.recovery_state_id)) {
      throw new Error(
        'Another owner changed this group. Refresh recovery and review the members before saving again.',
      );
    }
    const nextMembers = reconcile ? safeRecoveryMembers(heads) : [...new Set(members)].sort();
    const rotate =
      forceRotation ||
      reconcile ||
      heads.some((h) => h.state.members.some((p) => !nextMembers.includes(p)));
    const next: GroupRecoveryState = {
      ...heads[0].state,
      revision: newGroupRevision(),
      epoch: Math.max(...heads.map((h) => h.state.epoch)) + (rotate ? 1 : 0),
      epoch_revision: rotate ? newGroupRevision() : heads[0].state.epoch_revision,
      parents: heads.map((h) => h.id),
      members: nextMembers,
      owners: [...new Set([...heads.flatMap((h) => h.state.owners), d.account()!])],
    };
    const record = await publishState(secret.recovery_entropy!, next);
    const after = recoveryHeads(await fetchRecords(secret.recovery_entropy!, next.relays));
    if (after.length !== 1 || after[0].id !== record.id) {
      throw new Error(
        'Concurrent owner updates detected. Reconcile group recovery before sending invitations.',
      );
    }
    return install(secret.recovery_entropy!, record, records);
  }
  async function replicate(records: GroupRecoveryRecord[], targets: string[]) {
    const check = session();
    await d.connect(targets);
    for (const record of records) {
      check();
      if (!record.event)
        throw new Error('Missing signed recovery record. Refresh before retrying.');
      const result = await d.publish(new ClientEvent(d.ndk, record.event), targets, 'self');
      check();
      const accepted = new Set(
        result.relayStatuses
          .filter((s) => s.status === 'published')
          .map((s) => new URL(s.relay_url).href),
      );
      if (targets.some((url) => !accepted.has(new URL(url).href)))
        throw new Error(
          'Recovery history has not reached every relay. Retry before changing group relays.',
        );
    }
  }
  async function moveRelays(group: string, nextRelayUrls: string[]) {
    return exclusive(group, async () => {
      const secret = await secretFor(group);
      const targets = relays(nextRelayUrls);
      const old = secret.recovery_state!.relays;
      if (JSON.stringify([...old].sort()) === JSON.stringify([...targets].sort())) return;
      const records = await readJournal(secret.recovery_entropy!, old);
      const heads = recoveryHeads(records);
      if (heads.length !== 1 || heads[0].id !== secret.recovery_state_id)
        throw new Error(
          'Another owner changed the group. Refresh recovery before changing relays.',
        );
      await replicate(records, targets);
      const next: GroupRecoveryState = {
        ...heads[0].state,
        revision: newGroupRevision(),
        parents: [heads[0].id],
        relays: targets,
      };
      // Keep a signed pointer on the old relays so an older recovery file can find the new location.
      const record = await publishState(secret.recovery_entropy!, next, old);
      const observed = recoveryHeads(
        await fetchRecords(secret.recovery_entropy!, [...new Set([...old, ...targets])]),
      );
      if (observed.length !== 1 || observed[0].id !== record.id)
        throw new Error(
          'Concurrent owner updates detected. Reconcile recovery before changing relays.',
        );
      await install(secret.recovery_entropy!, record);
    });
  }
  async function refresh(group: string, reconcile = false) {
    return exclusive(group, async () => {
      const secret = await secretFor(group);
      const records = await readJournal(secret.recovery_entropy!, secret.recovery_state!.relays);
      const heads = recoveryHeads(records);
      if (heads.length !== 1 && !reconcile)
        throw new Error(
          'Conflicting owner updates. Reconcile keeps only members present in every conflicting update.',
        );
      if (reconcile) return update(group, [], true);
      if (!heads.length) throw new Error('Group recovery history is unavailable.');
      await replicate(records, heads[0].state.relays);
      return install(secret.recovery_entropy!, heads[0], records);
    });
  }
  async function backup(group: string) {
    const secret = await secretFor(group);
    return {
      phrase: groupPhraseFromEntropy(secret.recovery_entropy!),
      relays: secret.recovery_state!.relays,
    };
  }
  async function current(group: string, expectedStateId?: string) {
    const secret = await secretFor(group);
    const heads = recoveryHeads(
      await readJournal(secret.recovery_entropy!, secret.recovery_state!.relays),
    );
    if (heads.length !== 1 || (expectedStateId && heads[0].id !== expectedStateId)) {
      throw new Error(
        'Group ownership state changed. Refresh or reconcile recovery before sending.',
      );
    }
    return secretFromState(secret.recovery_entropy!, heads[0]);
  }
  async function assertCanSend(group: string, epochPublicKey: string) {
    const secret = await current(group);
    if (
      !secret.recovery_state!.members.includes(d.account()!) ||
      new NostrPrivateKeySigner(secret.epoch_privkey!).pubkey !== epochPublicKey
    ) {
      throw new Error(
        'The group epoch changed. Refresh group recovery and invitations before sending.',
      );
    }
  }
  async function assertCurrent(group: string) {
    const secret = await secretFor(group);
    const heads = recoveryHeads(
      await readJournal(secret.recovery_entropy!, secret.recovery_state!.relays),
    );
    if (heads.length !== 1 || heads[0].id !== secret.recovery_state_id)
      throw new Error(
        'Group ownership state changed. Refresh or reconcile recovery before sending.',
      );
  }
  return {
    create,
    inspect,
    restore,
    update,
    refresh,
    backup,
    assertCurrent,
    assertCanSend,
    current,
    exclusive,
    secretFor,
    moveRelays,
  };
}
