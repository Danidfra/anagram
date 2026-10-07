<script lang="ts">
  import GroupSeedBackup from './GroupSeedBackup.svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { contactsService } from '#src/services/contactsService.ts';
  import { chatDataService } from '#src/services/chatDataService.ts';
  import { nostrEventDataService } from '#src/services/nostrEventDataService.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { useChatStore } from '#src/stores/chatStore.ts';
  import { observe } from '#src/lib/state/store.ts';
  import type { ContactRecord, ContactRelay } from '#src/types/contact.ts';
  import type {
    ChatMetadata,
    ChatGroupEpochKey,
    GroupMemberTicketDelivery,
    MessageRelayStatus,
  } from '#src/types/chat.ts';
  import type { PublishUserMetadataInput, RelaySaveStatus } from '#src/stores/nostr/types.ts';
  import ProfileName from './ProfileName.svelte';
  import Avatar from './Avatar.svelte';

  export let publicKey: string;
  const nostr = useNostrStore();
  const version = observe(() => nostr.contactListVersion);
  let contact: ContactRecord | null = null;
  let epochs: Pick<
    ChatGroupEpochKey,
    'epoch_number' | 'epoch_public_key' | 'invitation_created_at'
  >[] = [];
  let deliveries: (GroupMemberTicketDelivery & { statuses: MessageRelayStatus[] })[] = [];
  let tab: 'Profile' | 'Members' | 'Relays' | 'Epochs' | 'Recovery' = 'Profile';
  let backup: { phrase: string; relays: string[] } | null = null;
  let replacement: 'none' | 'members' | 'backup' = 'none';
  let replacementMembers = '';
  let replacementConfirmed = false;
  let profile: PublishUserMetadataInput = {};
  let members = '';
  let reviewedStateId: string | undefined;
  let knownOwners: string[] = [];
  let relayEntries: ContactRelay[] = [];
  let relayUrl = '';
  let busy = false;
  let error = '';
  let notice = '';
  let mounted = false;
  let revision = 0;
  $: owner = Boolean(
    contact?.meta.owner_public_key === nostr.getLoggedInPublicKeyHex() &&
    contact?.meta.group_private_key_encrypted,
  );
  $: visibleMembers = [
    ...(owner &&
    contact?.meta.owner_public_key &&
    !(contact.meta.group_members ?? []).some(
      (member) => member.public_key === contact?.meta.owner_public_key,
    )
      ? [{ public_key: contact.meta.owner_public_key, name: '', given_name: '', picture: '' }]
      : []),
    ...(contact?.meta.group_members ?? []),
  ];
  $: if (mounted && publicKey && $version >= 0)
    void load(false).catch(() => {
      error = 'Unable to load group details. Please reopen the profile.';
    });

  async function load(reset: boolean) {
    const request = ++revision;
    const [next, chat] = await Promise.all([
      contactsService.getContactByPublicKey(publicKey),
      chatDataService.getChatByPublicKey(publicKey),
    ]);
    const first = !contact || contact.public_key !== publicKey;
    const recovery =
      (reset || first) &&
      next?.meta.group_private_key_encrypted &&
      next.meta.owner_public_key === nostr.getLoggedInPublicKeyHex()
        ? await nostr.groupRecovery.secretFor(publicKey)
        : null;
    const meta = (chat?.meta ?? {}) as ChatMetadata;
    const tickets = await Promise.all(
      (meta.group_member_ticket_deliveries ?? []).map(async (delivery) => ({
        ...delivery,
        statuses:
          (await nostrEventDataService.getEventById(delivery.event_id))?.relay_statuses ?? [],
      })),
    );
    if (request !== revision || !mounted) return;
    contact = next;
    // Only public epoch information belongs in the rendered view.
    epochs = (meta.group_epoch_keys ?? [])
      .map(({ epoch_number, epoch_public_key, invitation_created_at }) => ({
        epoch_number,
        epoch_public_key,
        invitation_created_at,
      }))
      .sort((a, b) => b.epoch_number - a.epoch_number);
    deliveries = tickets;
    if (reset || first) {
      const publicMeta = next?.meta ?? {};
      // Whitelist public profile fields: contact metadata also contains encrypted secrets.
      profile = Object.fromEntries(
        [
          'name',
          'about',
          'picture',
          'display_name',
          'website',
          'banner',
          'nip05',
          'lud16',
          'lud06',
          'bot',
          'birthday',
        ]
          .filter((key) => key in publicMeta)
          .map((key) => [key, publicMeta[key as keyof typeof publicMeta]]),
      );
      profile.name = profile.name || next?.name || '';
      members = (next?.meta.group_members ?? meta.group_members ?? [])
        .map((member) => nostr.encodeNpub(member.public_key))
        .join('\n');
      relayEntries = (next?.relays ?? []).map((entry) => ({ ...entry }));
      reviewedStateId = recovery?.recovery_state_id;
      knownOwners = recovery?.recovery_state?.owners ?? [];
      if (recovery) {
        members = (recovery.recovery_state?.members ?? [])
          .filter((key) => key !== nostr.getLoggedInPublicKeyHex())
          .map((key) => nostr.encodeNpub(key))
          .join('\n');
      }
    }
  }
  onMount(() => {
    mounted = true;
    return () => {
      mounted = false;
      revision++;
    };
  });
  function checkDelivery(status: RelaySaveStatus) {
    if (!status.publishedRelayUrls.length)
      throw new Error('No relay accepted the update. Please retry.');
    if (status.failedRelayUrls.length)
      notice = `Saved, but ${status.failedRelayUrls.length} relays need a retry.`;
  }
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      await action();
      await useChatStore().reload();
      await load(true);
      notice ||= 'Saved';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unable to update the group. Please retry.';
    } finally {
      busy = false;
    }
  }
  async function retryFailedInvitations() {
    const failed = deliveries.flatMap((delivery) =>
      delivery.statuses
        .filter((status) => status.direction === 'outbound' && status.status === 'failed')
        .map((status) => ({ eventId: delivery.event_id, relayUrl: status.relay_url })),
    );
    let failures = 0;
    for (const delivery of failed) {
      try {
        await nostr.retryGroupEpochTicketRelay(delivery.eventId, delivery.relayUrl);
      } catch {
        failures++;
      }
    }
    await load(false);
    if (failures) throw new Error(`${failures} relay deliveries still need a retry.`);
  }
  async function saveMembers(rotate = false) {
    const keys: string[] = [];
    for (const value of members.split(/[\s,]+/).filter(Boolean)) {
      const found = await nostr.resolveIdentifier(value);
      if (!found.normalizedPubkey)
        throw new Error('Enter a valid public key or NIP-05 address for each member.');
      keys.push(found.normalizedPubkey);
    }
    if (!reviewedStateId) throw new Error('Refresh recovery before editing group membership.');
    const result = rotate
      ? await nostr.rotateGroupEpochAndSendTickets(publicKey, keys, [], reviewedStateId)
      : await nostr.publishGroupMemberChanges(publicKey, keys, [], reviewedStateId);
    await load(true);
    if (result.failedMemberPubkeys.length)
      throw new Error(
        `Membership saved, but ${result.failedMemberPubkeys.length} invitations need a retry. Use Resend invitation below.`,
      );
  }
  async function replaceMaster(phrase: string) {
    await run(async () => {
      const keys: string[] = [];
      for (const value of replacementMembers.split(/[\s,]+/).filter(Boolean)) {
        const found = await nostr.resolveIdentifier(value);
        if (!found.normalizedPubkey)
          throw new Error('Enter valid public keys for the members to keep.');
        keys.push(found.normalizedPubkey);
      }
      const result = await nostr.createGroupChat({
        recoveryPhrase: phrase,
        name: profile.name || contact?.name || 'Private group',
        about: profile.about || '',
        relayUrls: contact?.relays.map((r) => r.url) ?? [],
      });
      await nostr.publishGroupMetadata(result.groupPublicKey, { ...profile, group: true });
      const delivery = await nostr.publishGroupMemberChanges(result.groupPublicKey, keys);
      replacement = 'none';
      await goto(`/contacts/${result.groupPublicKey}`);
      if (delivery.failedMemberPubkeys.length)
        throw new Error(
          'The replacement group is created. Retry failed invitations in its Members tab.',
        );
    });
  }
  function addRelay() {
    try {
      const url = new URL(relayUrl.trim());
      if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password)
        throw new Error();
      if (!relayEntries.some((entry) => entry.url === url.href))
        relayEntries = [...relayEntries, { url: url.href, read: true, write: true }];
      relayUrl = '';
      error = '';
    } catch {
      error = 'Enter a valid ws:// or wss:// relay URL.';
    }
  }
  async function saveRelays() {
    if (!reviewedStateId) throw new Error('Refresh recovery before editing group relays.');
    await nostr.groupRecovery.current(publicKey, reviewedStateId);
    if (!relayEntries.some((entry) => entry.read) || !relayEntries.some((entry) => entry.write))
      throw new Error('Keep at least one receiving and one publishing relay.');
    checkDelivery(
      await nostr.publishGroupRelayList(
        publicKey,
        relayEntries,
        contact?.relays?.map((entry) => entry.url) ?? [],
      ),
    );
    await nostr.refreshContactRelayList(publicKey);
  }
  async function refresh() {
    await Promise.all([
      nostr.refreshContactByPublicKey(publicKey),
      nostr.refreshGroupMembershipRoster(publicKey),
    ]);
    await load(true);
  }
</script>

<div class="group-details" data-testid="group-details">
  <div class="tabs" role="tablist" aria-label="Group details">
    {#each ['Profile', 'Members', 'Relays', 'Epochs', ...(owner ? ['Recovery'] : [])] as name}
      <button
        role="tab"
        aria-selected={tab === name}
        disabled={busy}
        onclick={() => {
          tab = name as typeof tab;
          backup = null;
          replacement = 'none';
        }}>{name}</button
      >
    {/each}
  </div>
  {#if !contact}<p>Loading group…</p>
  {:else if tab === 'Profile'}
    {#if owner}
      <label>Group name<input bind:value={profile.name} /></label>
      <label>Description<textarea bind:value={profile.about}></textarea></label>
      <label>Picture URL<input bind:value={profile.picture} /></label>
      <details>
        <summary>More profile fields</summary>
        {#each [['display_name', 'Display name'], ['website', 'Website'], ['banner', 'Banner URL'], ['nip05', 'NIP-05 address'], ['lud16', 'Lightning address'], ['lud06', 'LNURL']] as [key, label]}
          <label>{label}<input bind:value={profile[key]} /></label>
        {/each}
      </details>
      <button
        class="primary"
        disabled={busy}
        onclick={() =>
          run(async () => {
            await nostr.publishGroupMetadata(publicKey, { ...profile, group: true });
            await nostr.refreshContactByPublicKey(publicKey);
          })}>Save group profile</button
      >
    {:else}<h3>{contact.name}</h3>
      <p>{contact.meta.about ?? ''}</p>{/if}
    <button class="outline" disabled={busy} onclick={() => run(refresh)}>Refresh group</button>
  {:else if tab === 'Members'}
    <button class="outline" disabled={busy} onclick={() => run(refresh)}>Refresh members</button>
    {#if owner && deliveries.some( (delivery) => delivery.statuses.some((status) => status.direction === 'outbound' && status.status === 'failed') )}
      <button class="outline" disabled={busy} onclick={() => run(retryFailedInvitations)}
        >Retry all failed deliveries</button
      >
    {/if}
    {#each visibleMembers as member (member.public_key)}
      <div class="member" data-public-key={member.public_key}>
        <Avatar
          publicKey={member.public_key}
          name={member.name || member.public_key.slice(0, 12)}
          picture={member.picture ?? ''}
          size={36}
        />
        <div class="member-info">
          <button class="member-profile" onclick={() => goto(`/contacts/${member.public_key}`)}
            ><ProfileName
              publicKey={member.public_key}
              givenName={member.given_name ?? ''}
              fallback={member.name || member.public_key.slice(0, 16)}
            /></button
          ><small>{nostr.encodeNpub(member.public_key)}</small>
          {#if owner}
            {#each deliveries.filter((delivery) => delivery.member_public_key === member.public_key) as delivery}
              <small>Epoch {delivery.epoch_number}</small>
              {#each delivery.statuses.filter((status) => status.direction === 'outbound') as status}
                <small>{status.relay_url}: {status.status}</small>
                {#if status.status === 'failed'}<button
                    disabled={busy}
                    onclick={() =>
                      run(() =>
                        nostr.retryGroupEpochTicketRelay(delivery.event_id, status.relay_url),
                      )}>Retry relay</button
                  >{/if}
              {/each}
            {/each}
            <button
              class="outline"
              disabled={busy}
              onclick={() =>
                run(async () =>
                  checkDelivery(await nostr.sendGroupEpochTicket(publicKey, member.public_key)),
                )}>Resend invitation</button
            >
          {/if}
        </div>
      </div>
    {/each}
    {#if owner}
      <label>Member public keys<textarea rows="5" bind:value={members}></textarea></label>
      <p>
        Removing a member rotates the group keys. Existing messages remain available to previous
        members.
      </p>
      <button class="primary" disabled={busy} onclick={() => run(() => saveMembers())}
        >Update members</button
      >
      <button class="outline" disabled={busy} onclick={() => run(() => saveMembers(true))}
        >Rotate group keys</button
      >
    {/if}
  {:else if tab === 'Relays'}
    {#if !owner}
      {#each contact.relays ?? [] as entry}<div class="relay">
          {entry.url} · {entry.read ? 'Read' : ''}
          {entry.write ? 'Write' : ''}
        </div>{:else}<p>No relays configured.</p>{/each}
      <button class="outline" disabled={busy} onclick={() => run(refresh)}>Refresh group</button>
    {:else}
      {#each relayEntries as entry, index}
        <div class="relay">
          <span>{entry.url}</span><label
            ><input type="checkbox" bind:checked={entry.read} />Read</label
          ><label><input type="checkbox" bind:checked={entry.write} />Write</label><button
            disabled={busy}
            aria-label={`Remove ${entry.url}`}
            onclick={() => (relayEntries = relayEntries.filter((_, i) => i !== index))}
            >Remove</button
          >
        </div>
      {/each}
      <label>Relay URL<input bind:value={relayUrl} placeholder="wss://relay.example.com" /></label>
      <button class="outline" disabled={busy || !relayUrl.trim()} onclick={addRelay}
        >Add relay</button
      >
      <button class="primary" disabled={busy} onclick={() => run(saveRelays)}
        >Save group relays</button
      >
    {/if}
  {:else if tab === 'Recovery' && owner}
    {#if backup}
      <GroupSeedBackup
        phrase={backup.phrase}
        relayUrls={backup.relays}
        {busy}
        confirmLabel="Done"
        onverified={() => {
          backup = null;
        }}
      />
    {:else if replacement === 'backup'}
      <GroupSeedBackup
        relayUrls={contact.relays.map((r) => r.url)}
        {busy}
        confirmLabel="Create replacement group"
        onverified={replaceMaster}
      />
    {:else if replacement === 'members'}
      <h3>Replace the group master</h3>
      <p>
        This creates a new group identity and recovery phrase. The old group stays available for
        history. Previous owners cannot derive the new keys unless you share the new backup with
        them.
      </p>
      <label>Members to keep<textarea rows="5" bind:value={replacementMembers}></textarea></label>
      <p>
        Remove the accounts that should lose access. Remaining members will receive invitations to
        the replacement group. Share the new backup privately with only the owners you want to keep.
      </p>
      <label
        ><input type="checkbox" bind:checked={replacementConfirmed} />I have reviewed who should
        keep access</label
      >
      <button class="outline" onclick={() => (replacement = 'none')}>Cancel</button>
      <button
        class="primary"
        disabled={!replacementConfirmed}
        onclick={() => (replacement = 'backup')}>Back up replacement group</button
      >
    {:else}
      <h3>Group ownership and recovery</h3>
      <p>
        Your recovery words restore ownership and all recorded epoch keys. Share them privately only
        with someone who should have permanent co-owner access. Anyone importing them can manage the
        group.
      </p>
      {#if knownOwners.length}
        <p>Known owners</p>
        <ul>
          {#each knownOwners as key}<li>
              <ProfileName publicKey={key} fallback={key.slice(0, 16)} />
            </li>{/each}
        </ul>
      {/if}
      <button
        class="outline"
        disabled={busy}
        onclick={() =>
          run(async () => {
            backup = await nostr.groupRecovery.backup(publicKey);
          })}>Show ownership backup</button
      >
      <button
        class="outline"
        disabled={busy}
        onclick={() => run(() => nostr.groupRecovery.refresh(publicKey))}>Refresh recovery</button
      >
      <details>
        <summary>Resolve conflicting owner updates</summary>
        <p>
          Reconciliation creates a fresh epoch and keeps only members present in every conflicting
          update. Review members afterward and explicitly re-add anyone missing.
        </p>
        <button
          class="outline"
          disabled={busy}
          onclick={() =>
            run(async () => {
              const state = await nostr.groupRecovery.refresh(publicKey, true);
              const result = await nostr.publishGroupMemberChanges(
                publicKey,
                state.recovery_state!.members,
              );
              if (result.failedMemberPubkeys.length)
                throw new Error('Reconciled. Some invitations need a retry in Members.');
            })}>Reconcile owner updates</button
        >
      </details>
      <button
        class="outline"
        disabled={busy}
        onclick={() => {
          replacementMembers = members;
          replacementConfirmed = false;
          replacement = 'members';
        }}>Replace group master</button
      >
    {/if}
  {:else if tab === 'Epochs'}
    {#each epochs as epoch}
      <div class="epoch">
        <strong>Epoch {epoch.epoch_number}</strong><label
          >Epoch public key<input
            readonly
            value={nostr.encodeNpub(epoch.epoch_public_key)}
          /></label
        >{#if epoch.invitation_created_at}<small
            >{new Date(epoch.invitation_created_at).toLocaleString()}</small
          >{/if}
      </div>
    {:else}<p>No group invitations restored yet.</p>{/each}
  {/if}
  {#if busy}<p role="status">Saving…</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
</div>

<style>
  .tabs {
    display: flex;
    gap: 4px;
    margin: 16px 0;
    border-bottom: 1px solid var(--nc-border);
  }
  .tabs button {
    flex: 1;
    padding: 10px 4px;
  }
  .tabs button[aria-selected='true'] {
    color: var(--q-primary);
    border-bottom: 2px solid var(--q-primary);
  }
  .member {
    display: flex;
    align-items: start;
    gap: 10px;
    padding: 12px 0;
  }
  .member-info {
    min-width: 0;
    flex: 1;
  }
  small {
    display: block;
    overflow-wrap: anywhere;
    opacity: 0.75;
    margin: 4px 0;
  }
  .relay {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0;
  }
  .relay span {
    width: 100%;
    overflow-wrap: anywhere;
  }
  .relay label {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 4px;
    margin: 0;
  }
  .relay input {
    width: auto;
  }
  .epoch {
    padding: 12px 0;
    border-bottom: 1px solid var(--nc-border);
  }
  .outline,
  .primary {
    margin: 8px 4px 8px 0;
  }
</style>
