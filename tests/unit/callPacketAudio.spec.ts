import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('preserves native four-packet bursts and bounds a stalled decoder queue', async () => {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('isTauri', false);
  const posted: any[] = [];
  let worker: any;
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: (event: any) => void;
      constructor() {
        worker = this;
      }
      postMessage(message: any) {
        posted.push(message);
        if (message.type === 'boot')
          queueMicrotask(() => this.onmessage({ data: { type: 'ready' } }));
      }
      terminate() {}
    },
  );
  vi.stubGlobal(
    'AudioContext',
    class extends EventTarget {
      sampleRate = 48000;
      state = 'running';
      audioWorklet = { addModule: async () => {} };
      async resume() {}
      async close() {}
      createMediaStreamDestination() {
        return { stream: { getTracks: () => [] }, disconnect() {} };
      }
    },
  );
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = {};
      port2 = {};
    },
  );
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port = { postMessage() {}, close() {} };
      connect() {}
      disconnect() {}
    },
  );
  const { prepareCallPacketAudio, createPacketAudioReceiver } =
    await import('../../src/services/callPacketAudio.ts');
  const release = await prepareCallPacketAudio();
  const receiver = createPacketAudioReceiver(vi.fn());
  const received = () => {
    const last = posted.filter((message) => message.type === 'packet').at(-1);
    worker.onmessage({ data: { id: last.id, type: 'received', stats: {} } });
  };
  try {
    for (let i = 1; i <= 4; i++) receiver.append(new Uint8Array([i]));
    for (let i = 0; i < 4; i++) received();
    expect(posted.filter((m) => m.type === 'packet').map((m) => m.packet[0])).toEqual([1, 2, 3, 4]);
    for (let i = 5; i <= 20; i++) receiver.append(new Uint8Array([i]));
    for (let i = 0; i < 6; i++) received();
    expect(
      posted
        .filter((m) => m.type === 'packet')
        .map((m) => m.packet[0])
        .slice(4),
    ).toEqual([5, 16, 17, 18, 19, 20]);
    receiver.close();
    const count = posted.length;
    receiver.append(new Uint8Array([21]));
    expect(posted).toHaveLength(count);
  } finally {
    receiver.close();
    release?.();
  }
});

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
