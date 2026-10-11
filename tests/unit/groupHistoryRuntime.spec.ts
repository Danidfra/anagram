import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGroupHistoryRuntime,
  type GroupHistoryContext,
  type GroupHistoryQuery,
} from '#src/stores/nostr/groupHistoryRuntime.ts';

describe('demand-driven group history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1800000000000);
  });
  afterEach(() => vi.useRealTimers());
  const routes = (count: number, relayUrls = ['relay']) =>
    Array.from({ length: count }, (_, i) => ({ publicKey: `epoch-${count - i}`, relayUrls }));
  const empty = async ({ pager }: GroupHistoryQuery) => {
    pager.advance(0, Infinity);
    return { eventCount: 0 };
  };
  function setup(context: GroupHistoryContext, query = vi.fn(empty)) {
    let owner = 'account';
    const runtime = createGroupHistoryRuntime({
      owner: () => owner,
      context: async () => context,
      query,
      onError: vi.fn(),
    });
    return {
      runtime,
      query,
      setOwner: (value: string) => {
        owner = value;
      },
    };
  }
  it('bounds work for hundreds of epochs and resumes an unfinished page before older batches', async () => {
    const query = vi.fn(async ({ pager }: GroupHistoryQuery) => {
      pager.advance(128, pager.until - 100);
      return { eventCount: 128 };
    });
    const { runtime } = setup({ routes: routes(500), discoveryRelays: ['relay'] }, query);
    await runtime.load('group');
    expect(query).toHaveBeenCalledTimes(1);
    const first = query.mock.calls[0][0];
    expect(first.recipients).toHaveLength(16);
    const cursor = first.pager.until;
    await vi.advanceTimersByTimeAsync(3600000);
    expect(query).toHaveBeenCalledTimes(1);
    await runtime.load('group', cursor);
    const pages = query.mock.calls.map(([q]) => q).filter((q) => !q.discovery);
    expect(pages).toHaveLength(2);
    expect(pages[1].recipients).toEqual(first.recipients);
    expect(pages[1].pager).toBe(first.pager);
    expect(pages[1].pager.until).toBe(cursor - 100);
    expect(runtime.state.value.hasOlder).toBe(true);
  });
  it('limits even empty archives to six requests per action', async () => {
    const { runtime, query } = setup({ routes: routes(500), discoveryRelays: ['relay'] });
    await runtime.load('group');
    expect(query).toHaveBeenCalledTimes(6);
    expect(runtime.state.value.hasOlder).toBe(true);
    await runtime.load('group', 1700000000);
    expect(query.mock.calls.length).toBeLessThanOrEqual(12);
    expect(query.mock.calls[6][0].discovery).toBe(true);
    expect(query.mock.calls[7][0].recipients[0]).toBe('epoch-404');
  });
  it('recovers a ticket page before querying newly discovered epoch recipients', async () => {
    const context: GroupHistoryContext = { routes: [], discoveryRelays: ['relay'] };
    const query = vi.fn(async (q: GroupHistoryQuery) => {
      if (q.discovery) context.routes = routes(1);
      return empty(q);
    });
    const { runtime } = setup(context, query);
    await runtime.load('group');
    expect(query.mock.calls.map(([q]) => q.recipients)).toEqual([['account'], ['epoch-1']]);
    expect(runtime.state.value.hasOlder).toBe(false);
  });
  it('picks up late keys only on the next requested page', async () => {
    const context = { routes: routes(1), discoveryRelays: ['relay'] };
    const { runtime, query } = setup(context);
    await runtime.load('group');
    context.routes = routes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(query).toHaveBeenCalledTimes(1);
    await runtime.load('group', 1700000000);
    expect(query.mock.calls.at(-1)![0].recipients).toEqual(['epoch-2', 'epoch-1']);
    expect(query.mock.calls.at(-1)![0].pager.until).toBe(1800000000);
  });
  it('retains failed cursors and retries on demand after backoff', async () => {
    let failed = true;
    const query = vi.fn(async (q: GroupHistoryQuery) => {
      if (failed) throw new Error('closed without EOSE');
      return empty(q);
    });
    const { runtime } = setup({ routes: routes(1), discoveryRelays: [] }, query);
    await runtime.load('group');
    const pager = query.mock.calls[0][0].pager;
    expect(pager.done).toBe(false);
    expect(runtime.state.value).toMatchObject({ hasOlder: true, failed: true });
    await runtime.load('group');
    expect(query).toHaveBeenCalledTimes(1);
    failed = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(query).toHaveBeenCalledTimes(1);
    await runtime.load('group');
    expect(query.mock.calls[1][0].pager).toBe(pager);
    expect(pager.done).toBe(true);
  });
  it('coalesces requests, lets healthy replicas finish, and aborts on thread change', async () => {
    let release!: () => void;
    const query = vi.fn(async (q: GroupHistoryQuery) => {
      if (q.relayUrl === 'slow')
        await new Promise<void>((resolve) => {
          release = resolve;
          q.signal.addEventListener('abort', () => resolve());
        });
      return empty(q);
    });
    const { runtime } = setup(
      { routes: routes(1, ['slow', 'healthy']), discoveryRelays: [] },
      query,
    );
    const first = runtime.load('group');
    expect(runtime.load('group')).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0].pager.done).toBe(true);
    runtime.stop();
    release();
    await first;
    expect(query.mock.calls[0][0].signal.aborted).toBe(true);
    expect(runtime.state.value.chat).toBe('');
  });
  it('does not issue queries after the account changes during context lookup', async () => {
    const { runtime, query, setOwner } = setup({ routes: routes(1), discoveryRelays: [] });
    const work = runtime.load('group');
    setOwner('another-account');
    await work;
    expect(query).not.toHaveBeenCalled();
    runtime.stop();
  });
});
