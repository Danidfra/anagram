import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('releases the audio context when the codec worker cannot be created', async () => {
  const close = vi.fn(async () => {});
  vi.stubGlobal(
    'AudioContext',
    class {
      close = close;
    },
  );
  vi.stubGlobal('AudioWorkletNode', class {});
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('Worker creation unavailable');
      }
    },
  );
  const { prepareCallPacketAudio } = await import('../../src/services/callPacketAudio.ts');
  expect(await prepareCallPacketAudio()).toBeUndefined();
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  { native: true, agent: 'Mozilla/5.0 (X11; Linux x86_64)', create: false },
  { native: false, agent: 'Mozilla/5.0 (X11; Linux x86_64)', create: true },
  { native: true, agent: 'Mozilla/5.0 (Linux; Android 15)', create: true },
  { native: true, agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', create: true },
  { native: true, agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', create: true },
  { native: true, agent: 'Mozilla/5.0 (Windows NT 10.0)', create: true },
])(
  'avoids realtime worklets only in native Linux: $agent, native=$native',
  async ({ native, agent, create }) => {
    vi.stubGlobal('isTauri', native);
    vi.stubGlobal('navigator', { userAgent: agent });
    const opened = vi.fn();
    const closed = vi.fn(async () => {});
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          opened();
        }
        close = closed;
      },
    );
    vi.stubGlobal('AudioWorkletNode', class {});
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('Stop after platform capability check');
        }
      },
    );
    const { prepareCallPacketAudio } = await import('../../src/services/callPacketAudio.ts');
    expect(await prepareCallPacketAudio()).toBeUndefined();
    expect(opened).toHaveBeenCalledTimes(create ? 1 : 0);
    expect(closed).toHaveBeenCalledTimes(create ? 1 : 0);
  },
);
