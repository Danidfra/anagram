import { afterEach, expect, it, vi } from 'vitest';
import {
  createMobileCallAudio,
  hasMobileCallAudio,
  acquireMobileCallAudio,
} from '#src/services/mobileCallAudio.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});
it('only uses native routing on the phone apps', async () => {
  const agent = (userAgent: string) => vi.stubGlobal('navigator', { userAgent, maxTouchPoints: 0 });
  agent('Android');
  expect(hasMobileCallAudio()).toBe(false);
  await expect(acquireMobileCallAudio()).resolves.toBeTypeOf('function');
  vi.stubGlobal('isTauri', true);
  expect(hasMobileCallAudio()).toBe(true);
  agent('iPhone');
  expect(hasMobileCallAudio()).toBe(true);
  agent('Windows');
  expect(hasMobileCallAudio()).toBe(false);
  agent('Macintosh');
  expect(hasMobileCallAudio()).toBe(false);
});
it('defaults each new call to the receiver and holds the route until its last owner ends', async () => {
  const write = vi.fn().mockResolvedValue(undefined),
    changed = vi.fn();
  const audio = createMobileCallAudio(write, changed);
  const release = await audio.acquire();
  expect(write).toHaveBeenLastCalledWith(true, false);
  await audio.selectSpeaker(true);
  expect(write).toHaveBeenLastCalledWith(true, true);
  const other = await audio.acquire();
  expect(write).toHaveBeenLastCalledWith(true, true);
  release();
  release();
  await Promise.resolve();
  expect(write).toHaveBeenLastCalledWith(true, true);
  other();
  await vi.waitFor(() => expect(write).toHaveBeenLastCalledWith(false, false));
  const next = await audio.acquire();
  expect(write).toHaveBeenLastCalledWith(true, false);
  expect(changed).toHaveBeenLastCalledWith(false);
  next();
});
it('serializes hangup and immediate redial without leaving the new call inactive', async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  const audio = createMobileCallAudio(write);
  const end = await audio.acquire();
  let finish!: () => void;
  write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const selecting = audio.selectSpeaker(true);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  end();
  const next = audio.acquire();
  finish();
  await selecting;
  const endNext = await next;
  expect(write).toHaveBeenLastCalledWith(true, false);
  endNext();
});
it('releases a failed setup and allows the following call to retry', async () => {
  const write = vi
    .fn()
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValue(undefined);
  const audio = createMobileCallAudio(write);
  await expect(audio.acquire()).rejects.toThrow('unavailable');
  const end = await audio.acquire();
  expect(write).toHaveBeenLastCalledWith(true, false);
  end();
});
