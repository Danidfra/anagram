import { afterEach, expect, it, vi } from 'vitest';
import { recordCallMedia } from '#src/services/callMediaService.ts';
import { cloneCallTrack } from '#src/services/callSharedCapture.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('shares WebM encoding, resets late joiners in order, and isolates a stalled recipient', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('isTauri', false);
  const recorders: any[] = [];
  vi.stubGlobal(
    'MediaRecorder',
    class {
      state = 'inactive';
      ondataavailable: (event: { data: Blob }) => void;
      constructor() {
        recorders.push(this);
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      }
    },
  );
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(private tracks: any[]) {}
      getTracks() {
        return this.tracks;
      }
    },
  );
  const original = { clone: () => ({}) } as unknown as MediaStreamTrack;
  const stream = () => new MediaStream([cloneCallTrack(original)]);
  const first: string[] = [],
    second: string[] = [];
  const failure = vi.fn();
  let release!: () => void;
  const stopped = vi.fn();
  const a = recordCallMedia(
    stream(),
    'video/webm;codecs=vp8',
    async (bytes) => {
      first.push(String(bytes[1]));
    },
    failure,
    {
      onStreamRestart: async () => {
        first.push('reset');
      },
    },
  );
  await vi.advanceTimersByTimeAsync(100);
  recorders[0].ondataavailable({ data: new Blob([new Uint8Array([1])]) });
  await vi.advanceTimersByTimeAsync(0);
  const b = recordCallMedia(
    stream(),
    'video/webm;codecs=vp8',
    async (bytes) => {
      second.push(String(bytes[1]));
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    failure,
    {
      onStreamRestart: async () => {
        second.push('reset');
      },
      onCongestion: stopped,
    },
  );
  expect(recorders).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(recorders[0].state).toBe('inactive');
  expect(recorders).toHaveLength(2);
  recorders[1].ondataavailable({ data: new Blob([new Uint8Array([2])]) });
  await vi.advanceTimersByTimeAsync(0);
  recorders[1].ondataavailable({ data: new Blob([new Uint8Array([3])]) });
  await vi.advanceTimersByTimeAsync(1750);
  expect(first).toEqual(['1', 'reset', '2', '3']);
  expect(second).toEqual(['2']);
  expect(stopped).toHaveBeenCalledOnce();
  expect(recorders[1].state).toBe('recording');
  expect(failure).not.toHaveBeenCalled();
  release();
  b();
  a();
  expect(recorders[1].state).toBe('inactive');
});
