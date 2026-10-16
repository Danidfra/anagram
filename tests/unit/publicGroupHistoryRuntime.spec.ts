import { afterEach, expect, it, vi } from 'vitest';
import { createPublicGroupHistoryRuntime } from '#src/stores/nostr/publicGroupHistoryRuntime.ts';

afterEach(() => vi.useRealTimers());

it('keeps the unfinished relay cursor while a healthy replica progresses', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const requests: Array<{ url: string; until: number }> = [];
  let stalled = true;
  const runtime = createPublicGroupHistoryRuntime({
    owner: () => 'account',
    query: async ({ relayUrl, pager, signal }) => {
      requests.push({ url: relayUrl, until: pager.until });
      if (relayUrl === 'slow' && stalled) {
        await new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Incomplete read')), {
            once: true,
          }),
        );
      }
      pager.advance(128, pager.until - 100);
    },
  });
  const first = runtime.load('room', ['slow', 'healthy']);
  await vi.advanceTimersByTimeAsync(501);
  await first;
  expect(runtime.error).toBeUndefined();
  expect(runtime.hasOlder(['slow', 'healthy'])).toBe(true);
  stalled = false;
  await vi.advanceTimersByTimeAsync(1000);
  await runtime.load('room', ['slow', 'healthy']);
  expect(
    requests.filter((request) => request.url === 'slow').map((request) => request.until),
  ).toEqual([1800000000, 1800000000]);
  expect(
    requests.filter((request) => request.url === 'healthy').map((request) => request.until),
  ).toEqual([1800000000, 1799999900]);
  runtime.stop();
});

it('rotates a fixed request budget across relays instead of scanning between user actions', async () => {
  const calls: string[] = [];
  const runtime = createPublicGroupHistoryRuntime({
    owner: () => 'account',
    query: async ({ relayUrl, pager }) => {
      calls.push(relayUrl);
      pager.advance(128, pager.until - 100);
    },
  });
  const urls = ['a', 'b', 'c', 'd', 'e', 'f'];
  await runtime.load('room', urls);
  expect(calls).toEqual(['a', 'b', 'c', 'd']);
  await runtime.load('room', urls);
  await runtime.load('room', urls);
  expect(new Set(calls)).toEqual(new Set(urls));
  expect(calls).toHaveLength(12);
  runtime.stop();
});

it('retains inclusive timestamp boundaries and only finishes an exhausted read', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1800000000000);
  const limits: number[] = [];
  const runtime = createPublicGroupHistoryRuntime({
    owner: () => 'account',
    query: async ({ pager }) => {
      limits.push(pager.limit);
      pager.advance(limits.length === 1 ? 128 : limits.length === 2 ? 200 : 0, pager.until);
    },
  });
  await runtime.load('room', ['a']);
  expect(runtime.hasOlder(['a'])).toBe(true);
  await runtime.load('room', ['a']);
  expect(runtime.hasOlder(['a'])).toBe(true);
  await runtime.load('room', ['a']);
  expect(runtime.hasOlder(['a'])).toBe(false);
  expect(limits).toEqual([128, 256, 128]);
  runtime.stop();
});

it('cancels and isolates a previous room/account and coalesces repeated loads', async () => {
  let owner = 'first';
  const requests: AbortSignal[] = [];
  const runtime = createPublicGroupHistoryRuntime({
    owner: () => owner,
    query: async ({ signal }) => {
      requests.push(signal);
      await new Promise<void>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }),
      );
    },
  });
  const first = runtime.load('room', ['a']);
  expect(runtime.load('room', ['a'])).toBe(first);
  owner = 'second';
  const second = runtime.load('room', ['a']);
  expect(requests[0].aborted).toBe(true);
  expect(requests[1].aborted).toBe(false);
  runtime.stop();
  await Promise.all([first, second]);
  expect(requests[1].aborted).toBe(true);
});
