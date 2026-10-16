import { HistoryPager } from '#src/stores/nostr/historyPager.ts';

/** Public counterpart of groupHistoryRuntime: bounded, per-relay cursors,
 * advanced only after real EOSE and storage commit. No key discovery/decryption. */
export function createPublicGroupHistoryRuntime(deps: {
  owner: () => string | null;
  query: (input: {
    address: string;
    relayUrl: string;
    pager: HistoryPager;
    signal: AbortSignal;
  }) => Promise<void>;
}) {
  type Cursor = { pager: HistoryPager; retryAt: number; failures: number };
  let selected = '';
  let account: string | null = null;
  let until = 0;
  let offset = 0;
  let controller = new AbortController();
  let cursors = new Map<string, Cursor>();
  let active: Promise<void> | undefined;
  let error: unknown;
  function stop() {
    controller.abort();
    controller = new AbortController();
    selected = '';
    account = null;
    cursors = new Map();
    active = undefined;
    offset = 0;
    error = undefined;
  }
  function select(address: string) {
    if (selected === address && account === deps.owner()) return;
    stop();
    selected = address;
    account = deps.owner();
    until = Math.floor(Date.now() / 1000);
  }
  function cursor(url: string) {
    let value = cursors.get(url);
    if (!value) {
      value = { pager: new HistoryPager(0, until, true), retryAt: 0, failures: 0 };
      cursors.set(url, value);
    }
    return value;
  }
  function hasOlder(urls: string[]) {
    return urls.some((url) => !cursor(url).pager.done);
  }
  function load(address: string, urls: string[]): Promise<void> {
    select(address);
    if (active) return active;
    if (!account) return Promise.resolve();
    const owner = account,
      signal = controller.signal;
    const cancelled = () => signal.aborted || deps.owner() !== owner;
    // Like private groups, rotate relay slots so a failed replica neither blocks
    // another route's progress nor silently loses its own unfinished interval.
    const unique = [...new Set(urls)];
    const ordered = [...unique.slice(offset), ...unique.slice(0, offset)];
    offset = unique.length ? (offset + 1) % unique.length : 0;
    const scheduled = ordered
      .filter((url) => {
        const progress = cursor(url);
        return !progress.pager.done && progress.retryAt <= Date.now();
      })
      .slice(0, 4);
    error = undefined;
    const round = new AbortController();
    const cancelRound = () => round.abort();
    signal.addEventListener('abort', cancelRound, { once: true });
    const requestSignal = round.signal;
    let completed = 0;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.all(
      scheduled.map(async (relayUrl) => {
        const progress = cursor(relayUrl);
        try {
          await deps.query({ address, relayUrl, pager: progress.pager, signal: requestSignal });
          if (cancelled()) return;
          completed++;
          // Preserve public rooms' existing short grace period for slow replicas.
          // Their independent cursors stay put; partial reads never become EOSE.
          grace ??= setTimeout(() => round.abort(), 500);
          progress.failures = 0;
          progress.retryAt = 0;
        } catch (cause) {
          if (cancelled()) return;
          progress.retryAt =
            Date.now() + Math.min(30000, 1000 * 2 ** Math.min(progress.failures++, 5));
          error = cause;
        }
      }),
    )
      .then(() => {
        if (!cancelled() && completed) error = undefined;
      })
      .finally(() => {
        clearTimeout(grace);
        signal.removeEventListener('abort', cancelRound);
        if (active === work) active = undefined;
      });
    active = work;
    return work;
  }
  return {
    load,
    select,
    stop,
    hasOlder,
    get error() {
      return error;
    },
  };
}
