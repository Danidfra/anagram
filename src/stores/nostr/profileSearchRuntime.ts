import type NostrClient from '#src/lib/nostr/client.ts';
import {
  nip19,
  type ClientEvent,
  type NostrFilter,
  type NostrEvent,
} from '#src/lib/nostr/client.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';

export interface ProfileSearchResult {
  publicKey: string;
  name: string;
  picture: string;
  nip05: string;
  relayUrls: string[];
  createdAt?: number;
  eventId?: string;
  following?: boolean;
}
export type ProfileSearchStatus = 'complete' | 'unavailable' | 'invalid';
export const profileSearchAllowed = (
  query: string,
  privateKeys: (string | null | undefined)[] = [],
) =>
  query.trim().length >= 2 &&
  query.length <= 200 &&
  !/nsec1|bunker:\/\/|nostrconnect:\/\//i.test(query) &&
  !privateKeys.some((key) => key && query.toLowerCase().includes(key.toLowerCase()));
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/** Public NIP-02 membership only; never adds private contacts. */
export function followListEntries(event?: NostrEvent): Map<string, string> {
  const entries = new Map<string, string>();
  if (event?.kind !== 3) return entries;
  for (const tag of event.tags) {
    if (tag[0] === 'p' && /^[a-f0-9]{64}$/.test(tag[1] ?? '')) entries.set(tag[1], text(tag[3]));
    // Match the display-profile cache bound; no message history is read.
    if (entries.size >= 5000) break;
  }
  return entries;
}

/** Short-lived public discovery. It never replaces the message subscriptions,
 * creates contacts, or reads message history. Results stream before EOSE. */
export function searchRelayProfiles(
  client: NostrClient,
  query: string,
  relayUrls: string[] | Promise<string[]>,
  options: {
    signal: AbortSignal;
    account?: string | null;
    followList?: NostrEvent;
    cachedProfile?: (
      key: string,
    ) => { name: string; picture: string; createdAt?: number; eventId?: string } | undefined;
    onFollowList?: (event: NostrEvent) => void;
    onFollowProfile?: (profile: ProfileSearchResult) => void;
    onResults: (results: ProfileSearchResult[]) => void;
    isBlocked: (key: string) => boolean;
    resolveNip05: (
      identifier: string,
    ) => Promise<{ isValid: boolean; normalizedPubkey: string | null; relays: string[] }>;
  },
): Promise<ProfileSearchStatus> {
  if (!profileSearchAllowed(query)) return Promise.resolve('invalid');
  const value = query
    .trim()
    .replace(/^nostr:/i, '')
    .replace(/^@/, '');
  const results = new Map<string, ProfileSearchResult>();
  const subscriptions: Array<{ stop: () => void }> = [];
  const urls = (values: string[]) => [
    ...new Set(
      values
        .map((url) => inputSanitizerService.normalizeRelayWs(url))
        .filter((url): url is string => Boolean(url)),
    ),
  ];
  let followList = options.followList?.pubkey === options.account ? options.followList : undefined;
  let followed = followListEntries(followList);
  let stopped = false;
  return new Promise((resolve) => {
    const finish = (status: ProfileSearchStatus) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(deadline);
      options.signal.removeEventListener('abort', abort);
      subscriptions.forEach((subscription) => subscription.stop());
      resolve(status);
    };
    const abort = () => finish('complete');
    let receivedEose = false;
    const deadline = setTimeout(
      () => finish(results.size || receivedEose ? 'complete' : 'unavailable'),
      6000,
    );
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) {
      abort();
      return;
    }
    const emit = () => {
      if (!stopped)
        options.onResults(
          [...results.values()]
            .map((profile) => ({ ...profile, following: followed.has(profile.publicKey) }))
            .sort((a, b) => {
              const rank = (profile: ProfileSearchResult) =>
                Number(profile.name.toLowerCase() === value.toLowerCase());
              return (
                Number(b.following) - Number(a.following) ||
                rank(b) - rank(a) ||
                a.name.localeCompare(b.name) ||
                a.publicKey.localeCompare(b.publicKey)
              );
            })
            .slice(0, 20),
        );
    };
    void (async () => {
      let publicKey = '',
        nip05 = '';
      let hints: string[] = [];
      if (value.includes('@')) {
        if (!/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(value)) {
          finish('invalid');
          return;
        }
        const resolved = await options.resolveNip05(value.toLowerCase()).catch(() => null);
        if (stopped) return;
        if (!resolved?.isValid || !resolved.normalizedPubkey) {
          finish('complete');
          return;
        }
        publicKey = resolved.normalizedPubkey;
        hints = resolved.relays;
        nip05 = value.toLowerCase();
      } else if (/^[a-f0-9]{64}$/i.test(value)) publicKey = value.toLowerCase();
      else if (/^(npub|nprofile)1/i.test(value)) {
        try {
          const decoded = nip19.decode(value);
          if (decoded.type === 'npub') publicKey = decoded.data;
          else if (decoded.type === 'nprofile') {
            publicKey = decoded.data.pubkey;
            hints = decoded.data.relays ?? [];
          }
        } catch {
          finish('invalid');
          return;
        }
      }
      if (publicKey && (!/^[a-f0-9]{64}$/.test(publicKey) || options.isBlocked(publicKey))) {
        finish('complete');
        return;
      }
      const seedFollowed = () => {
        for (const [key, petname] of followed) {
          if (options.isBlocked(key) || (publicKey && key !== publicKey) || results.has(key))
            continue;
          const cached = options.cachedProfile?.(key);
          const name = cached?.name || petname || key.slice(0, 16);
          if (
            !publicKey &&
            ![name, petname, key].some((field) => field.toLowerCase().includes(value.toLowerCase()))
          )
            continue;
          results.set(key, {
            publicKey: key,
            name,
            picture: cached?.picture || '',
            nip05: '',
            relayUrls: [],
            createdAt: cached?.createdAt,
            eventId: cached?.eventId,
          });
        }
        if (results.size) emit();
      };
      seedFollowed();
      const targets = urls([...hints, ...(Array.isArray(relayUrls) ? relayUrls : await relayUrls)]);
      if (stopped) return;
      if (publicKey) {
        const cached = results.get(publicKey);
        results.set(publicKey, {
          ...cached,
          publicKey,
          name: cached?.name || nip05 || publicKey.slice(0, 16),
          picture: cached?.picture || '',
          nip05: nip05 || cached?.nip05 || '',
          relayUrls: targets,
        });
        emit();
      }
      if (!targets.length) {
        finish(results.size ? 'complete' : 'unavailable');
        return;
      }
      const filter: NostrFilter = publicKey
        ? { kinds: [0], authors: [publicKey], limit: 1 }
        : { kinds: [0], search: value, limit: 20 };
      // Ordinary metadata reads must survive rejection of the optional NIP-50 filter.
      const filters: NostrFilter[] = publicKey ? [filter] : [filter, { kinds: [0], limit: 100 }];
      let pending = 0;
      let scheduling = true;
      const receive = (event: ClientEvent) => {
        if (
          stopped ||
          event.kind !== 0 ||
          !/^[a-f0-9]{64}$/.test(event.pubkey) ||
          options.isBlocked(event.pubkey) ||
          (publicKey && event.pubkey !== publicKey)
        )
          return;
        let profile: Record<string, unknown>;
        try {
          profile = JSON.parse(event.content);
        } catch {
          return;
        }
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return;
        const name =
          text(profile.display_name) ||
          text(profile.displayName) ||
          text(profile.name) ||
          event.pubkey.slice(0, 16);
        const claimedNip05 = text(profile.nip05);
        const picture = text(profile.picture) || text(profile.image);
        const candidate: ProfileSearchResult = {
          publicKey: event.pubkey,
          name,
          picture: /^https?:\/\//i.test(picture) ? picture : '',
          nip05: nip05 || claimedNip05,
          relayUrls: targets,
          createdAt: event.created_at,
          eventId: event.id,
        };
        if (followed.has(event.pubkey)) options.onFollowProfile?.(candidate);
        // Relays without NIP-50 may ignore `search` and return arbitrary profiles.
        if (
          !publicKey &&
          ![
            name,
            text(profile.name),
            claimedNip05,
            event.pubkey,
            followed.get(event.pubkey) || '',
          ].some((field) => field.toLowerCase().includes(value.toLowerCase()))
        )
          return;
        const previous = results.get(event.pubkey);
        if (
          previous?.createdAt !== undefined &&
          ((event.created_at ?? 0) < previous.createdAt ||
            (event.created_at === previous.createdAt && event.id > (previous.eventId ?? '')))
        )
          return;
        if (!previous && results.size >= 40 && !followed.has(event.pubkey)) return;
        results.set(event.pubkey, candidate);
        emit();
      };
      const request = (
        requestedFilter: NostrFilter,
        receiveEvent: (event: ClientEvent) => void,
      ) => {
        // Each relay can stream useful results independently.
        pending += targets.length;
        for (const relay of targets) {
          let done = false,
            received = 0;
          const complete = () => {
            if (done) return;
            done = true;
            if (--pending === 0 && !scheduling)
              finish(results.size || receivedEose ? 'complete' : 'unavailable');
          };
          try {
            const sub = client.subscribe(requestedFilter, {
              relayUrls: [relay],
              closeOnEose: true,
              onEvent: (event) => {
                if (!stopped && !done && received++ < 256) receiveEvent(event);
              },
              onEose: () => {
                receivedEose = true;
                complete();
              },
              onClose: complete,
            });
            if (stopped) sub.stop();
            else subscriptions.push(sub);
          } catch {
            complete();
          }
        }
      };
      const requested = new Set<string>();
      const hydrateFollowed = () => {
        const keys = [...followed.keys()].filter(
          (key) =>
            !requested.has(key) && !options.isBlocked(key) && (!publicKey || key === publicKey),
        );
        for (let i = 0; i < keys.length; i += 100) {
          const authors = keys.slice(i, i + 100);
          authors.forEach((key) => requested.add(key));
          request({ kinds: [0], authors, limit: authors.length }, receive);
        }
      };
      for (const filter of filters) request(filter, receive);
      hydrateFollowed();
      if (options.account)
        request({ kinds: [3], authors: [options.account], limit: 1 }, (event) => {
          if (event.kind !== 3 || event.pubkey !== options.account) return;
          if (
            followList &&
            ((event.created_at ?? 0) < followList.created_at ||
              (event.created_at === followList.created_at && event.id >= followList.id))
          )
            return;
          followList = event.rawEvent();
          followed = followListEntries(followList);
          options.onFollowList?.(followList);
          seedFollowed();
          emit();
          hydrateFollowed();
        });
      scheduling = false;
      if (!pending) finish(results.size || receivedEose ? 'complete' : 'unavailable');
    })().catch(() => finish('unavailable'));
  });
}
