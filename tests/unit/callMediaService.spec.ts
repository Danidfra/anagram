import {
  callCaptureErrorKey,
  callMediaSupported,
  createCallMediaReceiver,
  getCallMedia,
  getCallMicrophone,
  recordCallMedia,
} from '#src/services/callMediaService.ts';
import {
  primeCallAudio,
  registerCallAudio,
  setCallSpeaker,
} from '#src/services/callPlaybackService.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
const platform = vi.hoisted(() => ({ ios: false }));
vi.mock('#src/lib/platform/ios.ts', () => ({ isIosNative: () => platform.ios }));

afterEach(() => {
  platform.ios = false;
  registerCallAudio(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe('call devices and playback', () => {
  it('checks browser capabilities, not cached microphone permission state', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    vi.stubGlobal('MediaSource', { isTypeSupported: () => true });
    const query = vi.fn().mockRejectedValue(new Error('Permissions API unavailable'));
    vi.stubGlobal('navigator', { permissions: { query }, mediaDevices: { getUserMedia: vi.fn() } });
    expect(callMediaSupported('audio')).toBe(true);
    expect(callMediaSupported('video')).toBe(true);
    expect(query).not.toHaveBeenCalled();
    vi.stubGlobal('isSecureContext', false);
    expect(callMediaSupported('audio')).toBe(false);
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('WebAssembly', undefined);
    expect(callMediaSupported('audio')).toBe(false);
  });
  it('does not imply permission denial when the device is busy or absent', () => {
    expect(callCaptureErrorKey(new DOMException('Denied', 'NotAllowedError'))).toBe(
      'call.error.permission',
    );
    expect(callCaptureErrorKey(new DOMException('Busy', 'NotReadableError'))).toBe(
      'call.error.deviceBusy',
    );
    expect(callCaptureErrorKey(new DOMException('Missing', 'NotFoundError'))).toBe(
      'call.error.deviceMissing',
    );
    expect(callCaptureErrorKey(new Error('Unexpected'))).toBe('call.error.capture');
  });
  it('supports iPhone managed playback only when recording and playback codecs both exist', () => {
    platform.ios = true;
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    vi.stubGlobal('MediaSource', undefined);
    const recorder = vi.fn(() => true);
    const player = vi.fn(() => true);
    vi.stubGlobal('MediaRecorder', { isTypeSupported: recorder });
    vi.stubGlobal('ManagedMediaSource', { isTypeSupported: player });
    expect(callMediaSupported('audio')).toBe(true);
    expect(callMediaSupported('video')).toBe(true);
    platform.ios = false;
    expect(callMediaSupported('audio')).toBe(false);
    expect(() => createCallMediaReceiver('audio/webm;codecs=opus', vi.fn())).toThrow('unavailable');
    platform.ios = true;
    player.mockImplementation((mime?: string) => !mime?.startsWith('video/'));
    expect(callMediaSupported('audio')).toBe(true);
    expect(callMediaSupported('video')).toBe(false);
    // Older iOS can have managed playback without the required WebM encoder.
    recorder.mockReturnValue(false);
    expect(callMediaSupported('audio')).toBe(false);
    recorder.mockReturnValue(true);
    vi.stubGlobal('ManagedMediaSource', undefined);
    expect(callMediaSupported('audio')).toBe(false);
    expect(() => createCallMediaReceiver('audio/webm;codecs=opus', vi.fn())).toThrow('unavailable');
  });
  it('keeps the standard playback path on browsers exposing both APIs', () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true });
    vi.stubGlobal('MediaSource', { isTypeSupported: () => true });
    const managed = vi.fn();
    vi.stubGlobal('ManagedMediaSource', { isTypeSupported: managed });
    expect(callMediaSupported('video')).toBe(true);
    expect(managed).not.toHaveBeenCalled();
  });
  it('selects an exact microphone without requesting camera access', async () => {
    const getUserMedia = vi.fn().mockResolvedValue({});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await getCallMicrophone('mic-2');
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'mic-2' },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  });
  it('falls back from a disconnected microphone preference when starting a new call', async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('Removed microphone', 'NotFoundError'))
      .mockResolvedValue({});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    await getCallMedia('audio', 'removed-device');
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1]?.[0].audio.deviceId).toBeUndefined();
  });
  it('primes the persistent audio element without treating autoplay denial as input denial', async () => {
    const element = {
      src: '',
      muted: true,
      play: vi.fn().mockRejectedValue(new DOMException('Autoplay', 'NotAllowedError')),
    } as unknown as HTMLAudioElement;
    registerCallAudio(element);
    primeCallAudio();
    await Promise.resolve();
    expect(element.play).toHaveBeenCalledOnce();
    expect(element.src).toMatch(/^data:audio\/wav/);
    expect(element.muted).toBe(false);
    element.src = 'blob:live-call';
    primeCallAudio();
    expect(element.play).toHaveBeenCalledOnce();
  });
  it('uses the system speaker where output selection is unavailable and preserves failures', async () => {
    const element = {} as HTMLMediaElement;
    await expect(setCallSpeaker(element, '')).resolves.toBeUndefined();
    await expect(setCallSpeaker(element, 'headset')).rejects.toThrow('unavailable');
    element.setSinkId = vi.fn().mockResolvedValue(undefined);
    await setCallSpeaker(element, 'headset');
    expect(element.setSinkId).toHaveBeenCalledWith('headset');
    vi.mocked(element.setSinkId).mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    await expect(setCallSpeaker(element, 'denied')).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
  });
});

describe('continuous media buffering', () => {
  it.each(['MediaSource', 'ManagedMediaSource'])('bounds buffering and cleans up %s', (api) => {
    class Buffer extends EventTarget {
      updating = false;
      buffered = { length: 1, start: () => 0, end: () => 20 };
      appendBuffer = vi.fn();
      remove = vi.fn(() => {
        this.dispatchEvent(new Event('updateend'));
      });
    }
    const buffer = new Buffer();
    class Source extends EventTarget {
      static current: Source;
      duration = 0;
      constructor() {
        super();
        Source.current = this;
      }
      addSourceBuffer() {
        return buffer;
      }
    }
    vi.stubGlobal('MediaSource', undefined);
    vi.stubGlobal(api, Source);
    platform.ios = api === 'ManagedMediaSource';
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:media');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const failure = vi.fn();
    const receiver = createCallMediaReceiver('audio/webm;codecs=opus', failure);
    receiver.append(new Uint8Array([1, 2]));
    Source.current.dispatchEvent(new Event('sourceopen'));
    expect(buffer.remove).toHaveBeenCalledTimes(1);
    expect(buffer.appendBuffer).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    buffer.dispatchEvent(new Event('updateend'));
    expect(buffer.remove).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
    receiver.close();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:media');
  });
  it('cancels an old recorder chunk awaiting conversion before a microphone reset', async () => {
    class Recorder {
      static current: Recorder;
      state = 'inactive';
      ondataavailable:
        ((event: { data: { size: number; arrayBuffer(): Promise<ArrayBuffer> } }) => void) | null =
        null;
      onerror: (() => void) | null = null;
      constructor() {
        Recorder.current = this;
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
      }
    }
    vi.stubGlobal('MediaRecorder', Recorder);
    let complete: (value: ArrayBuffer) => void = () => {};
    const send = vi.fn().mockResolvedValue(undefined);
    const stop = recordCallMedia({} as MediaStream, 'audio/webm;codecs=opus', send, vi.fn());
    Recorder.current.ondataavailable?.({
      data: {
        size: 2,
        arrayBuffer: () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      },
    });
    await Promise.resolve();
    stop();
    complete(new ArrayBuffer(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(Recorder.current.state).toBe('inactive');
  });
});

it('stops a congested video recorder by queue age without dropping chunks or ending audio', async () => {
  vi.useFakeTimers();
  class Recorder {
    static current: Recorder;
    state = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      Recorder.current = this;
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
    }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const congestion = vi.fn(),
    failure = vi.fn();
  const send = vi.fn(() => new Promise<void>(() => {}));
  const stop = recordCallMedia({} as MediaStream, 'video/webm;codecs=vp8', send, failure, {
    onCongestion: congestion,
  });
  try {
    Recorder.current.ondataavailable?.({
      data: { size: 2, arrayBuffer: async () => new ArrayBuffer(2) } as Blob,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledOnce();
    now = 1600;
    await vi.advanceTimersByTimeAsync(250);
    expect(congestion).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    expect(Recorder.current.state).toBe('inactive');
    await vi.advanceTimersByTimeAsync(5000);
    expect(congestion).toHaveBeenCalledOnce();
  } finally {
    stop();
    vi.useRealTimers();
  }
});
