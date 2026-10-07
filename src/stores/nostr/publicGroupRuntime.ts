import type { MessageAttachmentMetadata, MessageRelayStatus } from '#src/types/chat.ts';
import { redactPublicLinks } from '#src/utils/publicMessage.ts';
import { previewUrl } from '#src/utils/linkPreview.ts';
import { writable, get, type Readable } from 'svelte/store';
import type NostrClient from '#src/lib/nostr/client.ts';
import {
  ClientEvent,
  type NostrEvent,
  type NostrFilter,
  type NostrSigner,
  type NostrSubscription,
} from '#src/lib/nostr/client.ts';
import {
  PublicGroupData,
  type SavedPublicRoom,
  type PublicGroupMessage,
} from '#src/services/publicGroupData.ts';
import {
  decodeRoomLink,
  encodeRoomLink,
  parsePublicRoom,
  publicRoomRelays,
  newerRoom,
  roomPolicy,
  roomTags,
  validRoomMessage,
  verifiedPublicEvent,
  ROOM_PAGE,
  ROOM_WINDOW,
  type PublicRoom,
  type RoomAddress,
} from './publicGroups.ts';

interface State {
  rooms: SavedPublicRoom[];
  room: PublicRoom | null;
  ancestors: PublicRoom[];
  history: string;
  messages: PublicGroupMessage[];
  loading: boolean;
  refreshing: boolean;
  hasNewer: boolean;
  error: string;
  stale: boolean;
  more: boolean;
}
interface Dependencies {
  client: NostrClient;
  account: () => string | null;
  signer: () => Promise<NostrSigner>;
  relays: () => Promise<string[]>;
  containsSecret: (value: string) => boolean;
}
export function createPublicGroupRuntime(deps: Dependencies) {
  const state = writable<State>({
    rooms: [],
    room: null,
    ancestors: [],
    history: '',
    messages: [],
    loading: false,
    refreshing: false,
    hasNewer: false,
    error: '',
    stale: false,
    more: true,
  });
  // Message hydration must not invalidate the entire application's chat list.
  const sidebar: Readable<{ rooms: SavedPublicRoom[]; address: string }> = {
    subscribe(run) {
      let rooms: SavedPublicRoom[] | undefined, address: string | undefined;
      return state.subscribe((s) => {
        const nextAddress = s.room?.address ?? '';
        if (rooms === s.rooms && address === nextAddress) return;
        rooms = s.rooms;
        address = nextAddress;
        run({ rooms, address });
      });
    },
  };
  let account = '',
    data: PublicGroupData | undefined,
    view = 0;
  let live: NostrSubscription | undefined;
  let liveRevision = 0;
  let liveKey = '';
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  function stopLive() {
    liveRevision++;
    liveKey = '';
    clearTimeout(liveTimer);
    liveTimer = undefined;
    live?.stop();
    live = undefined;
  }
  const queries = new Set<() => void>();
  let writing = false;
  let requested = '';
  function assertSession(owner: string) {
    if (owner !== deps.account() || account !== owner)
      throw new Error('Account changed. Reopen the public group.');
  }
  function stopView() {
    view++;
    stopLive();
    for (const stop of [...queries]) stop();
  }
  function stop() {
    stopView();
    void data?.close();
    data = undefined;
    account = '';
    state.set({
      rooms: [],
      room: null,
      ancestors: [],
      history: '',
      messages: [],
      loading: false,
      refreshing: false,
      hasNewer: false,
      error: '',
      stale: false,
      more: true,
    });
  }
  async function init() {
    const next = deps.account();
    if (!next) {
      stop();
      return;
    }
    if (account === next && data) return;
    stop();
    account = next;
    data = new PublicGroupData(next);
    await reloadRooms();
  }
  async function reloadRooms() {
    const owner = account;
    const rows = await data!.list();
    assertSession(owner);
    const valid = rows.flatMap((row) => {
      try {
        return [{ ...row, room: parsePublicRoom(row.room.event, row.address) }];
      } catch {
        return [];
      }
    });
    state.update((s) => ({
      ...s,
      rooms: valid.filter((r) => r.joined && !r.successor).sort((a, b) => b.updated - a.updated),
    }));
  }
  async function relayUrls(hints: string[], fallback = true) {
    const configured = await deps.relays();
    const urls = publicRoomRelays(hints.length ? hints : fallback ? configured : [], configured);
    if (!urls.length)
      throw new Error('No usable public group relays. Configure a relay or check the group link.');
    return urls;
  }
  // Public reads need a real completed response containing the signed room, not
  // availability of every replica. Owner edits still require all requested relays.
  function query(
    filters: NostrFilter[],
    urls: string[],
    max = 400,
    accept?: (events: ClientEvent[]) => boolean,
    allowPartial = false,
  ): Promise<{ events: ClientEvent[]; complete: boolean }> {
    return new Promise((resolve, reject) => {
      const completed = new Map<string, ClientEvent>();
      const observed = new Map<string, ClientEvent>();
      const subscriptions: NostrSubscription[] = [];
      let settled = false,
        remaining = urls.length,
        failed = false,
        completedRelays = 0;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        queries.delete(cancel);
        subscriptions.forEach((sub) => sub.stop());
        error
          ? reject(error)
          : resolve({ events: [...completed.values()], complete: remaining === 0 && !failed });
      };
      const cancel = () => finish(new Error('Public group request cancelled.'));
      const timer = setTimeout(
        () =>
          finish(
            allowPartial && completedRelays
              ? undefined
              : new Error('Public group relays did not complete the request. Retry.'),
          ),
        10000,
      );
      queries.add(cancel);
      for (const url of urls) {
        const events = new Map<string, ClientEvent>();
        let ended = false;
        const end = (ok: boolean) => {
          if (settled || ended) return;
          ended = true;
          remaining--;
          if (ok) {
            completedRelays++;
            for (const [id, event] of events) completed.set(id, event);
          } else failed = true;
          if (completed.size > max) {
            finish(new Error('Too many public group events. Narrow the history request.'));
          } else if (accept?.([...completed.values()])) finish();
          else if (!remaining) {
            finish(
              failed && !(allowPartial && completedRelays)
                ? new Error('Public group relays disconnected before completing the request.')
                : undefined,
            );
          }
        };
        subscriptions.push(
          deps.client.subscribe(filters, {
            relayUrls: [url],
            onEvent: (event) => {
              if (settled || ended) return;
              if (observed.size >= max && !observed.has(event.id))
                finish(new Error('Too many public group events. Narrow the history request.'));
              else {
                if (!observed.has(event.id)) observed.set(event.id, event);
                const observedEvent = observed.get(event.id)!;
                const relay = deps.client.pool.getRelay(url, false);
                if (!observedEvent.onRelays.some((item) => item.url === url))
                  observedEvent.onRelays.push(relay);
                events.set(event.id, observedEvent);
              }
            },
            onEose: () => end(true),
            onClose: () => end(false),
          }),
        );
      }
    });
  }
  async function readRoom(
    address: RoomAddress,
    hints: string[] = address.relays,
    requireAll = false,
  ): Promise<PublicRoom> {
    const owner = account,
      db = data!;
    const urls = await relayUrls(hints);
    const baseline = await db.get(address.address);
    const cachedPolicy = baseline && parsePublicRoom(baseline.room.event, address.address);
    assertSession(owner);
    const { events } = await query(
      [{ kinds: [34550], authors: [address.owner], '#d': [address.slug], limit: 1 }],
      urls,
      32,
      requireAll
        ? undefined
        : (events) =>
            events.some((event) => {
              try {
                const candidate = parsePublicRoom(event.rawEvent(), address.address);
                return !cachedPolicy || !newerRoom(cachedPolicy, candidate);
              } catch {
                return false;
              }
            }),
    );
    const rooms = events.flatMap((e) => {
      try {
        return [parsePublicRoom(e.rawEvent(), address.address)];
      } catch {
        return [];
      }
    });
    if (!rooms.length)
      throw new Error('Public group not found or its signed definition is invalid.');
    const result = rooms.reduce((a, b) => (newerRoom(a, b) ? a : b));
    assertSession(owner);
    const saved = await db.get(address.address);
    if (saved) {
      const cached = parsePublicRoom(saved.room.event, address.address);
      if (newerRoom(cached, result))
        throw new Error('Relays returned an older group policy. Showing the last verified policy.');
    }
    return result;
  }
  async function saveRoom(room: PublicRoom, joined = true, successor?: string, owner = account) {
    assertSession(owner);
    const db = data!;
    const previous = await db.get(room.address);
    assertSession(owner);
    const saved = {
      address: room.address,
      room,
      joined,
      successor: successor || previous?.successor,
      updated: Date.now(),
    };
    await db.save(saved);
    assertSession(owner);
    state.update((s) => ({
      ...s,
      rooms: [
        ...s.rooms.filter((row) => row.address !== room.address),
        ...(saved.joined && !saved.successor ? [saved] : []),
      ]
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 200),
    }));
  }
  function append(events: PublicGroupMessage[], older = false) {
    state.update((s) => {
      const all = [...new Map([...s.messages, ...events].map((e) => [e.id!, e])).values()].sort(
        (a, b) => a.created_at - b.created_at || a.id!.localeCompare(b.id!),
      );
      return {
        ...s,
        messages: older ? all.slice(0, ROOM_WINDOW) : all.slice(-ROOM_WINDOW),
        hasNewer: older ? s.hasNewer || all.length > ROOM_WINDOW : s.hasNewer,
      };
    });
  }
  async function open(link: string) {
    await init();
    if (!data) return;
    stopView();
    const token = view,
      owner = account,
      db = data;
    const refreshingCurrent = requested === link && Boolean(get(state).room);
    requested = link;
    state.update((s) => ({
      ...s,
      room: refreshingCurrent ? s.room : null,
      ancestors: refreshingCurrent ? s.ancestors : [],
      history: '',
      messages: refreshingCurrent && !s.history ? s.messages : [],
      loading: false,
      refreshing: true,
      hasNewer: false,
      error: '',
      stale: true,
      more: true,
    }));
    let address: RoomAddress;
    try {
      address = decodeRoomLink(link);
    } catch (e) {
      state.update((s) => ({ ...s, refreshing: false, error: String((e as Error).message) }));
      return;
    }
    const rootAddress = address;
    try {
      // Show the last signed room and its bounded local window before touching
      // the network. Follow only handovers already verified and pinned locally.
      let cachedAddress = address;
      const cachedAncestors: PublicRoom[] = [];
      const cachedSeen = new Set<string>();
      for (let hop = 0; hop < 8 && !cachedSeen.has(cachedAddress.address); hop++) {
        cachedSeen.add(cachedAddress.address);
        const saved = await db.get(cachedAddress.address);
        if (token !== view || owner !== account) return;
        if (!saved?.joined && !saved?.successor) break;
        const cachedRoom = parsePublicRoom(saved.room.event, cachedAddress.address);
        if (
          cachedAncestors.length &&
          cachedRoom.predecessor?.address !== cachedAncestors.at(-1)!.address
        )
          break;
        if (saved.successor && cachedRoom.successor?.address === saved.successor) {
          cachedAncestors.push(cachedRoom);
          cachedAddress = cachedRoom.successor;
          continue;
        }
        if (cachedRoom.successor) break;
        const cached = await db.page(cachedRoom.address, undefined, ROOM_PAGE);
        if (token !== view || owner !== account) return;
        state.update((s) => ({
          ...s,
          room: cachedRoom,
          ancestors: cachedAncestors,
          messages: cached.filter((e) => validRoomMessage(e, cachedRoom.address)),
        }));
        // Live messages hydrate even while a replica's policy lookup is pending.
        const urls = await relayUrls(cachedRoom.relays, false);
        if (token !== view || owner !== account) return;
        startLive(cachedRoom, urls, token, owner, db);
        break;
      }
      const ancestors: PublicRoom[] = [];
      const seen = new Set<string>();
      let room: PublicRoom;
      for (let hop = 0; ; hop++) {
        if (hop >= 8 || seen.has(address.address))
          throw new Error('Invalid or excessive public group handover chain.');
        seen.add(address.address);
        const saved = await db.get(address.address);
        // Pin accepted handovers: a former owner cannot redirect this client again.
        room = saved?.successor
          ? parsePublicRoom(saved.room.event, address.address)
          : await readRoom(address, saved?.room.relays ?? address.relays);
        assertSession(owner);
        if (token !== view) return;
        if (ancestors.length && room.predecessor?.address !== ancestors.at(-1)!.address)
          throw new Error('The successor owner has not accepted this handover.');
        if (!room.successor) break;
        if (room.successor.owner === room.owner)
          throw new Error('Ownership transfer requires a different owner.');
        ancestors.push(room);
        address = room.successor;
      }
      const declared = await relayUrls(room.relays, false);
      // Check the policy on the declared room relays as well as the link hints.
      const lookupUrls = await relayUrls(
        (await db.get(room.address))?.room.relays ?? address.relays,
      );
      if (JSON.stringify([...lookupUrls].sort()) !== JSON.stringify([...declared].sort()))
        room = await readRoom(room, declared);
      if (ancestors.length && room.predecessor?.address !== ancestors.at(-1)!.address)
        throw new Error('Successor acknowledgement changed.');
      if (room.successor)
        throw new Error('Group ownership changed while loading. Refresh to follow the handover.');
      assertSession(owner);
      if (token !== view) return;
      for (const prior of ancestors) {
        if (token !== view) return;
        await saveRoom(prior, false, prior.successor!.address, owner);
      }
      assertSession(owner);
      if (token !== view) return;
      if (
        !get(state).rooms.some((r) => r.address === room.address) &&
        get(state).rooms.length >= 200
      )
        throw new Error('Leave an unused public group before joining another.');
      await saveRoom(room, true, undefined, owner);
      const cached = await db.page(room.address, undefined, ROOM_PAGE);
      assertSession(owner);
      if (token !== view) return;
      state.update((s) => ({
        ...s,
        room,
        ancestors,
        messages:
          s.room?.address === room.address
            ? s.messages
            : cached.filter((e) => validRoomMessage(e, room.address)),
        refreshing: false,
        stale: false,
      }));
      if (token !== view) return;
      const urls = await relayUrls(room.relays, false);
      if (token !== view || owner !== account) return;
      startLive(room, urls, token, owner, db);
    } catch (e) {
      if (token !== view || owner !== account) return;
      // Only previously joined, signed policy may be displayed offline. Never infer an empty blocklist.
      const saved = await db.get(rootAddress.address);
      let candidate: PublicRoom | null = null;
      try {
        if (saved) candidate = parsePublicRoom(saved.room.event, rootAddress.address);
      } catch {
        // Corrupt cached metadata must not turn a failed refresh into an unhandled rejection.
      }
      const room = candidate && !candidate.successor && !saved?.successor ? candidate : null;
      const cached = room ? await db.page(room.address, undefined, ROOM_PAGE) : [];
      if (token !== view || owner !== account) return;
      state.update((s) => ({
        ...s,
        room,
        messages:
          room && s.room?.address === room.address
            ? s.messages
            : room
              ? cached.filter((e) => validRoomMessage(e, room.address))
              : [],
        refreshing: false,
        stale: true,
        error: (e as Error).message,
      }));
    }
  }
  function startLive(
    room: PublicRoom,
    urls: string[],
    token: number,
    owner: string,
    db: PublicGroupData,
  ) {
    const key = JSON.stringify([owner, token, room.address, [...urls].sort()]);
    if (live && liveKey === key) return;
    stopLive();
    liveKey = key;
    const revision = liveRevision;
    const active = () => revision === liveRevision && token === view && owner === deps.account();
    let draining = false;
    let received = 0;
    const pending: PublicGroupMessage[] = [];
    live = deps.client.subscribe(
      [
        { kinds: [9], '#a': [room.address], limit: ROOM_PAGE },
        { kinds: [34550], authors: [room.owner], '#d': [room.slug], limit: 1 },
      ],
      {
        relayUrls: urls,
        includeRelayDuplicates: true,
        onEvent: (event, relay) => {
          if (!active()) return;
          if (pending.length >= 256) {
            stopLive();
            state.update((s) => ({
              ...s,
              stale: true,
              error: 'Public group traffic exceeded the local queue. Refresh to catch up.',
            }));
            return;
          }
          if (event.kind === 9) received++;
          pending.push(receivedMessage(event, relay?.url ?? event.relay?.url));
          if (!draining && liveTimer === undefined)
            liveTimer = setTimeout(() => {
              liveTimer = undefined;
              void drain();
            }, 0);
        },
        onEose: () => {
          if (active() && !get(state).messages.length && received === 0)
            state.update((s) => ({ ...s, more: false }));
        },
        onClose: () => {
          if (active() && !get(state).refreshing)
            state.update((s) => ({
              ...s,
              stale: true,
              error: 'Public group connection closed. Refresh to reconnect.',
            }));
        },
      },
    );
    async function drain() {
      if (draining) return;
      draining = true;
      try {
        while (pending.length && active()) {
          const event = pending.shift()!;
          const current = get(state).room!;
          if (event.kind === 34550) {
            let next: PublicRoom;
            try {
              next = parsePublicRoom(event, current.address);
            } catch {
              continue;
            }
            if (!newerRoom(next, current)) continue;
            if (next.successor) {
              void open(requested);
              return;
            }
            state.update((s) => ({ ...s, room: next }));
            await saveRoom(next, true, undefined, owner);
            if (!active()) return;

            if (JSON.stringify(next.relays) !== JSON.stringify(current.relays)) {
              void open(requested);
              return;
            }
          } else {
            const batch = [event];
            // Do not move messages across an owner policy update.
            while (batch.length < 64 && pending[0]?.kind === 9) batch.push(pending.shift()!);
            const valid = batch.filter((e) => validRoomMessage(e, current.address));
            if (!valid.length) continue;
            const saved = await db.putMany(current.address, valid);
            if (active() && !get(state).history && !get(state).hasNewer) append(saved);
          }
        }
      } catch {
        if (active())
          state.update((s) => ({
            ...s,
            error: 'Could not save public messages. Refresh to retry.',
          }));
      } finally {
        draining = false;
      }
    }
  }
  async function older() {
    const s = get(state);
    if (!s.room || s.loading) return;
    const token = view,
      owner = account,
      db = data!,
      address = s.history || s.room.address;
    const first = s.messages[0];
    state.update((s) => ({ ...s, loading: true, error: '' }));
    try {
      let complete = false;
      let events = await db.page(
        address,
        first ? { created_at: first.created_at, id: first.id! } : undefined,
        ROOM_PAGE,
      );
      if (!events.length) {
        const room = s.ancestors.find((r) => r.address === address) || s.room;
        const result = await query(
          [
            {
              kinds: [9],
              '#a': [address],
              ...(first ? { until: first.created_at } : {}),
              limit: ROOM_WINDOW,
            },
          ],
          await relayUrls(room.relays),
          ROOM_WINDOW * 8,
          (events) =>
            events.filter(
              (e) =>
                validRoomMessage(e.rawEvent(), address) &&
                (!first ||
                  e.created_at < first.created_at ||
                  (e.created_at === first.created_at && e.id < first.id!)),
            ).length >= ROOM_PAGE,
          true,
        );
        const raw = result.events;
        complete = result.complete;
        if (
          first &&
          raw.length >= ROOM_WINDOW &&
          raw.every((e) => e.created_at === first.created_at)
        )
          throw new Error(
            'This relay returned a dense message batch. Earlier history could not be fully paged.',
          );
        events = raw
          .map((e) => receivedMessage(e))
          .filter(
            (e) =>
              validRoomMessage(e, address) &&
              (!first ||
                e.created_at < first.created_at ||
                (e.created_at === first.created_at && e.id! < first.id!)),
          );
        events.sort((a, b) => a.created_at - b.created_at || a.id!.localeCompare(b.id!));
        events = events.slice(-ROOM_PAGE);
        assertSession(owner);
        if (token !== view) return;
        events = await db.putMany(address, events);
      }
      assertSession(owner);
      if (token !== view) return;
      if ((get(state).history || get(state).room?.address) !== address) return;
      append(events, true);
      state.update((s) => ({ ...s, more: !complete || events.length === ROOM_PAGE }));
    } catch (e) {
      if (token === view) state.update((s) => ({ ...s, error: (e as Error).message }));
    } finally {
      if (token === view) state.update((s) => ({ ...s, loading: false }));
    }
  }
  async function newer() {
    const s = get(state);
    if (!s.room || s.loading || !s.hasNewer) return;
    const token = view,
      owner = account,
      db = data!;
    const last = s.messages.at(-1);
    if (!last) return;
    state.update((s) => ({ ...s, loading: true }));
    try {
      const events = await db.page(
        s.history || s.room.address,
        { created_at: last.created_at, id: last.id! },
        ROOM_PAGE,
        'next',
      );
      if (token !== view || owner !== account) return;
      append(events.filter((e) => validRoomMessage(e, s.history || s.room!.address)));
      state.update((s) => ({ ...s, hasNewer: events.length === ROOM_PAGE, more: true }));
    } catch {
      if (token === view)
        state.update((s) => ({ ...s, error: 'Could not load newer public messages.' }));
    } finally {
      if (token === view) state.update((s) => ({ ...s, loading: false }));
    }
  }
  async function history(address: string) {
    const s = get(state);
    if (!s.room || s.loading || (address && !s.ancestors.some((r) => r.address === address)))
      return;
    state.update((s) => ({ ...s, history: address, messages: [], more: true, hasNewer: false }));
    await older();
  }
  function receivedMessage(event: ClientEvent, url?: string): PublicGroupMessage {
    const urls = [...new Set(url ? [url] : event.onRelays.map((relay) => relay.url))];
    return {
      ...event.rawEvent(),
      relay_statuses: urls.map((relay_url) => ({
        relay_url,
        direction: 'inbound',
        scope: 'subscription',
        status: 'received',
        updated_at: new Date().toISOString(),
      })),
    };
  }
  async function publish(
    event: ClientEvent,
    relays: string[],
    owner = account,
    record?: (event: NostrEvent, statuses: MessageRelayStatus[]) => Promise<void>,
  ) {
    assertSession(owner);
    if (deps.containsSecret(JSON.stringify(event.rawEvent())))
      throw new Error('Public content contains your session secret.');
    const signer = await deps.signer();
    assertSession(owner);
    if (signer.pubkey !== owner)
      throw new Error('Public group signer does not match this account.');
    await event.sign(signer);
    assertSession(owner);
    if (!verifiedPublicEvent(event.rawEvent()))
      throw new Error(
        'Public group content exceeds the event limits. Shorten the content or moderation lists.',
      );
    // Keep replication running with bounded timeouts, but one real relay ACK
    // is enough to confirm a public post. A dead replica must not stall typing.
    await publishSigned(event, relays, record);
    assertSession(owner);
  }
  async function publishSigned(
    event: ClientEvent,
    relays: string[],
    record?: (event: NostrEvent, statuses: MessageRelayStatus[]) => Promise<void>,
  ) {
    const report = (urls: string[], status: MessageRelayStatus['status'], detail?: string) =>
      record?.(
        event.rawEvent(),
        urls.map((relay_url) => ({
          relay_url,
          direction: 'outbound',
          scope: 'recipient',
          status,
          updated_at: new Date().toISOString(),
          ...(detail ? { detail } : {}),
        })),
      );
    await report(relays, 'pending');
    try {
      await Promise.any(
        relays.map(async (url) => {
          try {
            const relay = deps.client.pool.getRelay(url, false);
            await relay.connect();
            await relay.publish(event, 8000);
          } catch (error) {
            await report([url], 'failed', String(error).slice(0, 300));
            throw error;
          }
          await report([url], 'published');
        }),
      );
    } catch {
      throw new Error('No public group relay accepted this event. Retry when connected.');
    }
  }
  async function create(input: {
    name: string;
    about: string;
    picture: string;
    predecessor?: string;
  }) {
    await init();
    const owner = account;
    if (
      !input.name.trim() ||
      input.name.length > 100 ||
      input.about.length > 2000 ||
      (input.picture && !previewUrl(input.picture))
    )
      throw new Error('Use a group name, a short description and a public HTTPS picture URL.');
    if (get(state).rooms.length >= 200)
      throw new Error('Leave an unused public group before adding another.');
    const predecessor = input.predecessor ? decodeRoomLink(input.predecessor) : undefined;
    if (predecessor) await readRoom(predecessor);
    const urls = await relayUrls([]);
    const event = new ClientEvent(deps.client, {
      kind: 34550,
      content: '',
      tags: roomTags({
        ...input,
        slug: crypto.randomUUID(),
        relays: urls,
        trusted: [],
        blocked: [],
        predecessor,
      }),
    });
    await publish(event, urls, owner);
    assertSession(owner);
    const room = parsePublicRoom(event.rawEvent());
    await saveRoom(room, true, undefined, owner);
    return encodeRoomLink(room);
  }
  async function update(
    input: Partial<
      Pick<PublicRoom, 'name' | 'about' | 'picture' | 'trusted' | 'blocked' | 'successor'>
    >,
    expectedId: string,
  ) {
    if (writing) throw new Error('Another public group change is being saved.');
    writing = true;
    try {
      const room = get(state).room,
        owner = account;
      if (!room || room.owner !== owner || room.successor)
        throw new Error('Only the current owner can change this group.');
      const urls = await relayUrls(room.relays);
      const fresh = await readRoom(room, urls, true);
      assertSession(owner);
      if (fresh.event.id !== expectedId || fresh.successor)
        throw new Error('The group changed. Refresh and review before saving.');
      if (input.successor) {
        const target = await readRoom(input.successor);
        if (
          target.owner === owner ||
          target.predecessor?.address !== room.address ||
          target.successor
        )
          throw new Error(
            'The new owner must create a fresh group accepting this group as its predecessor.',
          );
        input = { ...input, successor: target };
      }
      const next = { ...fresh, ...input };
      const event = new ClientEvent(deps.client, {
        kind: 34550,
        content: '',
        created_at: Math.max(Math.floor(Date.now() / 1000), fresh.event.created_at + 1),
        tags: roomTags(next),
      });
      // Validate the proposed schema before asking a signer or publishing.
      if (
        (next.picture && !previewUrl(next.picture)) ||
        !next.name.trim() ||
        next.name.length > 100 ||
        next.about.length > 2000 ||
        next.blocked.includes(owner) ||
        [...next.trusted, ...next.blocked].some((k) => !/^[a-f0-9]{64}$/.test(k)) ||
        next.trusted.length > 1024 ||
        next.blocked.length > 1024
      )
        throw new Error('Invalid public group profile or moderation list.');
      await publish(event, urls, owner);
      assertSession(owner);
      await saveRoom(parsePublicRoom(event.rawEvent()), true, undefined, owner);
      await open(requested);
    } finally {
      writing = false;
    }
  }
  async function send(text: string, attachment?: MessageAttachmentMetadata) {
    const s = get(state),
      room = s.room,
      owner = account;
    if (!room || s.history || s.stale || room.successor || roomPolicy(room, owner) === 'blocked')
      throw new Error('Posting is unavailable in this public group.');
    if (!text.trim() || text.length > 8000)
      throw new Error('Messages must contain 1–8,000 characters.');
    if (
      attachment &&
      (roomPolicy(room, owner) !== 'trusted' ||
        !previewUrl(attachment.url) ||
        !/^(image|video)\//.test(attachment.mimeType))
    )
      throw new Error('Media posting requires a trusted account and a public HTTPS URL.');
    const token = view,
      db = data!;
    const event = new ClientEvent(deps.client, {
      kind: 9,
      content: roomPolicy(room, owner) === 'trusted' ? text.trim() : redactPublicLinks(text.trim()),
      tags: [
        ['a', room.address],
        ...(attachment
          ? [
              [
                'imeta',
                `url ${attachment.url}`,
                `m ${attachment.mimeType}`,
                `size ${attachment.size}`,
                ...(attachment.sha256 ? [`x ${attachment.sha256}`] : []),
              ],
            ]
          : []),
      ],
    });
    await publish(
      event,
      await relayUrls(room.relays),
      owner,
      statusRecorder(room.address, owner, db, token),
    );
  }
  function statusRecorder(address: string, owner: string, db: PublicGroupData, token: number) {
    return async (event: NostrEvent, statuses: MessageRelayStatus[]) => {
      if (owner !== account || owner !== deps.account() || data !== db) return;
      const saved = await db.put(address, { ...event, relay_statuses: statuses });
      if (owner !== account || owner !== deps.account() || data !== db) return;
      if (token === view && !get(state).history && !get(state).hasNewer) append([saved]);
    };
  }
  async function retryMessage(eventId: string, url: string) {
    const s = get(state),
      room = s.room,
      owner = account,
      db = data!,
      token = view;
    if (!room || s.stale || s.history || roomPolicy(room, owner) === 'blocked')
      throw new Error('Posting is unavailable in this public group.');
    if (!(await relayUrls(room.relays)).includes(url))
      throw new Error('Relay is not used by this group.');
    const event = await db.message(room.address, eventId);
    assertSession(owner);
    if (get(state).room?.event.id !== room.event.id || get(state).stale || get(state).history)
      throw new Error('Group policy changed. Reopen relay details before retrying.');
    if (
      token !== view ||
      !event ||
      event.pubkey !== owner ||
      !validRoomMessage(event, room.address)
    )
      throw new Error('Message is unavailable for retry.');
    if (
      roomPolicy(room, owner) !== 'trusted' &&
      (redactPublicLinks(event.content) !== event.content ||
        event.tags.some((t) => t[0] === 'imeta'))
    )
      throw new Error('This post requires a trusted account.');
    if (
      !event.relay_statuses?.some(
        (s) => s.relay_url === url && s.direction === 'outbound' && s.status === 'failed',
      )
    )
      throw new Error('Only failed deliveries can be retried.');
    await publishSigned(
      new ClientEvent(deps.client, event),
      [url],
      statusRecorder(room.address, owner, db, token),
    );
  }
  async function leave(address: string) {
    stopView();
    const owner = account,
      db = data!;
    const row = await db.get(address);
    assertSession(owner);
    if (row) await db.save({ ...row, joined: false });
    assertSession(owner);
    state.update((s) => ({
      ...s,
      room: null,
      messages: [],
      rooms: s.rooms.filter((r) => r.address !== address),
    }));
  }
  return {
    state,
    sidebar,
    init,
    open,
    stop,
    stopView,
    create,
    update,
    send,
    retryMessage,
    older,
    newer,
    history,
    leave,
  };
}
