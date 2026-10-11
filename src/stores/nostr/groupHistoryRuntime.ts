import { ref } from '#src/lib/state/reactivity.ts';
import { HistoryPager } from '#src/stores/nostr/historyPager.ts';

export interface GroupHistoryContext {
  routes: Array<{ publicKey: string; relayUrls: string[] }>;
  discoveryRelays: string[];
}
export interface GroupHistoryQuery {
  owner: string;
  recipients: string[];
  relayUrl: string;
  pager: HistoryPager;
  signal: AbortSignal;
  discovery: boolean;
}

// One user action has a fixed network budget. Cursors advance only after the
// caller has received real EOSE and committed the page. No background scan.
export function createGroupHistoryRuntime(deps: {
  owner: () => string | null;
  context: (chat: string) => Promise<GroupHistoryContext | null>;
  query: (query: GroupHistoryQuery) => Promise<{ eventCount: number }>;
  onError: (error: unknown) => void;
}) {
  const state = ref({ chat: '', loading: false, hasOlder: true, phase: 'messages', failed: false });
  type Cursor = { pager: HistoryPager; retryAt: number; failures: number };
  let selected = '';
  let abort = new AbortController();
  let active: Promise<void> | undefined;
  let cursors = new Map<string, Cursor>();
  let generation = 0;
  let relayOffset = 0;
  let initialUntil: number | undefined;
  function stop() {
    generation++;
    abort.abort();
    abort = new AbortController();
    selected = '';
    initialUntil = undefined;
    relayOffset = 0;
    cursors = new Map();
    active = undefined;
    state.value = { chat: '', loading: false, hasOlder: true, phase: 'messages', failed: false };
  }
  function load(chat: string, before?: number): Promise<void> {
    if (chat !== selected) {
      stop();
      selected = chat;
      state.value.chat = chat;
    }
    if (active) return active;
    const owner = deps.owner();
    if (!owner) return Promise.resolve();
    const token = generation,
      signal = abort.signal,
      saved = cursors;
    const cancelled = () => signal.aborted || generation !== token || deps.owner() !== owner;
    const now = Math.floor(Date.now() / 1000);
    const until = Number.isFinite(before) ? Math.min(now, Math.floor(before!) + 2 * 86400) : now;
    // Newly discovered keys can change a batch after earlier pages were read.
    // Seed every new batch from the session boundary, never from an old visible
    // ticket row: otherwise unread messages in the previous batch can be skipped.
    initialUntil ??= until;
    const cursor = (key: string, discovery: boolean) => {
      let value = saved.get(key);
      if (!value) {
        value = {
          pager: new HistoryPager(0, discovery ? now : initialUntil!, true),
          retryAt: 0,
          failures: 0,
        };
        saved.set(key, value);
      }
      return value;
    };
    state.value.loading = true;
    state.value.failed = false;
    const work = (async () => {
      let context = await deps.context(chat);
      if (!context || cancelled()) return;
      let budget = 6;
      async function request(recipients: string[], relayUrl: string, discovery: boolean) {
        const progress = cursor(
          `${discovery ? 'keys' : 'messages'}:${relayUrl}:${recipients.join(',')}`,
          discovery,
        );
        if (progress.pager.done || progress.retryAt > Date.now() || cancelled() || budget <= 0)
          return undefined;
        budget--;
        try {
          const result = await deps.query({
            owner: owner!,
            recipients,
            relayUrl,
            pager: progress.pager,
            signal,
            discovery,
          });
          if (cancelled()) return undefined;
          progress.failures = 0;
          progress.retryAt = 0;
          return result.eventCount;
        } catch (error) {
          if (cancelled()) return undefined;
          progress.retryAt =
            Date.now() + Math.min(30000, 1000 * 2 ** Math.min(progress.failures++, 5));
          state.value.failed = true;
          deps.onError(error);
          return undefined;
        }
      }
      const batches = (ctx: GroupHistoryContext, relay: string) => {
        const keys = ctx.routes
          .filter((route) => route.relayUrls.includes(relay))
          .map((route) => route.publicKey);
        return Array.from({ length: Math.ceil(keys.length / 16) }, (_, n) =>
          keys.slice(n * 16, n * 16 + 16),
        );
      };
      const relays = [
        ...new Set([
          ...context.routes.flatMap((route) => route.relayUrls),
          ...context.discoveryRelays,
        ]),
      ];
      const ordered = [...relays.slice(relayOffset), ...relays.slice(0, relayOffset)];
      relayOffset = relays.length ? (relayOffset + 4) % relays.length : 0;
      // Each relay recovers a ticket page and then a message page independently.
      // A slow key lookup on one replica cannot hold up known keys on another.
      await Promise.all(
        ordered.slice(0, 4).map(async (relay) => {
          if (
            (before !== undefined || !context!.routes.length) &&
            context!.discoveryRelays.includes(relay)
          ) {
            state.value.phase = 'keys';
            await request([owner!], relay, true);
          }
          if (cancelled()) return;
          const updated = await deps.context(chat);
          if (!updated || cancelled()) return;
          state.value.phase = 'messages';
          for (const recipients of batches(updated, relay)) {
            const progress = cursor(`messages:${relay}:${recipients.join(',')}`, false);
            if (progress.pager.done) continue;
            const count = await request(recipients, relay, false);
            // Do not jump over an unfinished epoch batch, even when another relay
            // already supplied older messages. Continue past genuinely empty pages.
            if (count === undefined || count > 0 || !progress.pager.done) break;
          }
        }),
      );
      if (cancelled()) return;
      context = await deps.context(chat);
      if (!context || cancelled()) return;
      const messageRelays = new Set(context.routes.flatMap((route) => route.relayUrls));
      const messagesDone = [...messageRelays].every((relay) =>
        batches(context!, relay).every(
          (keys) => cursor(`messages:${relay}:${keys.join(',')}`, false).pager.done,
        ),
      );
      const keysDone =
        context.discoveryRelays.length > 0 &&
        context.discoveryRelays.every((relay) => cursor(`keys:${relay}:${owner}`, true).pager.done);
      state.value.hasOlder = !messagesDone || !keysDone || state.value.failed;
    })()
      .catch((error) => {
        if (!cancelled()) {
          state.value.failed = true;
          deps.onError(error);
        }
      })
      .finally(() => {
        if (!cancelled()) state.value.loading = false;
        if (active === work) active = undefined;
      });
    active = work;
    return work;
  }
  function invalidate(chat: string) {
    if (selected === chat) state.value.hasOlder = true;
  }
  return { state, load, stop, invalidate };
}
