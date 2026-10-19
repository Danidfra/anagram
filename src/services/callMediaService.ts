import {
  PACKET_VIDEO_MIME,
  createPacketVideoReceiver,
  recordPacketVideo,
} from './callPacketVideo.ts';
export { callPacketVideoSupported } from './callPacketVideo.ts';
import { OPUS_CALL_MIME } from './callAudioPackets.ts';
import { createPacketAudioReceiver, recordPacketAudio } from './callPacketAudio.ts';
export { prepareCallPacketAudio } from './callPacketAudio.ts';
import type { CallMode } from '#src/types/call.ts';
import { CALL_MIME_TYPES, CALL_VIDEO_MIME_TYPE } from '#src/utils/callSignal.ts';
import { isIosNative } from '#src/lib/platform/ios.ts';
import { isTauri } from '@tauri-apps/api/core';

// The native iPhone app exposes ManagedMediaSource instead of MediaSource.
// Other clients retain their existing playback path and capability checks.
function callMediaSource(): typeof MediaSource | undefined {
  return typeof MediaSource !== 'undefined'
    ? MediaSource
    : isIosNative()
      ? (globalThis as typeof globalThis & { ManagedMediaSource?: typeof MediaSource })
          .ManagedMediaSource
      : undefined;
}

export function callMediaSupported(mode: CallMode): boolean {
  const mime = CALL_MIME_TYPES[1];
  const Source = callMediaSource();
  return (
    globalThis.isSecureContext === true &&
    typeof WebAssembly !== 'undefined' &&
    typeof WebSocket !== 'undefined' &&
    typeof crypto.randomUUID === 'function' &&
    typeof MediaRecorder !== 'undefined' &&
    Source !== undefined &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    Boolean(mime) &&
    MediaRecorder.isTypeSupported(mime) &&
    Source.isTypeSupported(mime) &&
    (mode === 'audio' ||
      (MediaRecorder.isTypeSupported(CALL_VIDEO_MIME_TYPE) &&
        Source.isTypeSupported(CALL_VIDEO_MIME_TYPE)))
  );
}

export function callCaptureErrorKey(cause: unknown): string {
  const name = cause && typeof cause === 'object' && 'name' in cause ? cause.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'call.error.permission';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'call.error.deviceMissing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'call.error.deviceBusy';
  return 'call.error.capture';
}

function audioConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}
const videoConstraints: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 360 },
  frameRate: { ideal: 24, max: 24 },
  facingMode: 'user',
};
export function getCallMicrophone(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: audioConstraints(deviceId), video: false });
}
export function getCallCamera(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { ...videoConstraints, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
  });
}
export function canShareCallScreen(): boolean {
  return (
    callMediaSupported('video') && typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  );
}
export function getCallScreen(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 15, max: 15 },
    },
  });
}
export async function getCallMedia(mode: CallMode, deviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints(deviceId),
      video: mode === 'video' ? videoConstraints : false,
    });
  } catch (cause) {
    // A disconnected preference must not prevent starting the next call.
    if (
      deviceId &&
      cause instanceof DOMException &&
      (cause.name === 'NotFoundError' ||
        (cause.name === 'OverconstrainedError' &&
          'constraint' in cause &&
          cause.constraint === 'deviceId'))
    ) {
      return getCallMedia(mode);
    }
    throw cause;
  }
}

export interface CallMediaReceiver {
  url: string;
  append(data: Uint8Array): void;
  close(): void;
}

// Each peer produces a continuous WebM stream; preserve every segment and bound buffering.
export function createCallMediaReceiver(mimeType: string, onError: () => void): CallMediaReceiver {
  if (mimeType === OPUS_CALL_MIME) return createPacketAudioReceiver(onError);
  if (mimeType === PACKET_VIDEO_MIME) return createPacketVideoReceiver(onError);
  const Source = callMediaSource();
  if (!Source) throw new Error('Streaming call playback is unavailable');
  const source = new Source();
  const url = URL.createObjectURL(source);
  let buffer: SourceBuffer | null = null;
  const pending: Uint8Array<ArrayBuffer>[] = [];
  let queuedBytes = 0;
  let closed = false;
  let lastPrunedUntil = 0;
  const pump = () => {
    if (closed || !buffer || buffer.updating) return;
    try {
      if (buffer.buffered.length) {
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        if (end > 12 && end - 8 > lastPrunedUntil + 1 && buffer.buffered.start(0) < end - 8) {
          lastPrunedUntil = end - 8;
          buffer.remove(0, lastPrunedUntil);
          return;
        }
      }
      const segment = pending.shift();
      if (segment) {
        queuedBytes -= segment.byteLength;
        buffer.appendBuffer(segment);
      }
    } catch {
      onError();
    }
  };
  const open = () => {
    if (closed) return;
    try {
      buffer = source.addSourceBuffer(mimeType);
      source.duration = Number.POSITIVE_INFINITY;
      buffer.addEventListener('updateend', pump);
      buffer.addEventListener('error', onError);
      pump();
    } catch {
      onError();
    }
  };
  source.addEventListener('sourceopen', open, { once: true });
  return {
    url,
    append(data) {
      if (closed) return;
      queuedBytes += data.byteLength;
      if (queuedBytes > 2_097_152) {
        onError();
        return;
      }
      pending.push(new Uint8Array(data));
      pump();
    },
    close() {
      closed = true;
      source.removeEventListener('sourceopen', open);
      buffer?.removeEventListener('updateend', pump);
      buffer?.removeEventListener('error', onError);
      pending.length = 0;
      URL.revokeObjectURL(url);
    },
  };
}

export interface CallRecordingOptions {
  audioGeneration?: number;
  videoFrameRate?: number;
  videoBitsPerSecond?: number;
  onCongestion?: () => void;
  onSendError?: (cause: unknown) => void;
}

export function recordCallMedia(
  stream: MediaStream,
  mimeType: string,
  send: (bytes: Uint8Array) => Promise<void>,
  onError: () => void,
  options?: CallRecordingOptions,
): () => void {
  if (mimeType === OPUS_CALL_MIME) return recordPacketAudio(stream, send, onError, options);
  if (mimeType === PACKET_VIDEO_MIME) return recordPacketVideo(stream, send, onError, options);
  const nativeLinux =
    isTauri() && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
  const timeslice = mimeType === CALL_MIME_TYPES[1] ? 50 : 100;
  const recorder = new MediaRecorder(stream, {
    mimeType,
    audioBitsPerSecond: 32_000,
    videoBitsPerSecond: options?.videoBitsPerSecond ?? 600_000,
  });
  let stopped = false;
  let keyframeTimer: ReturnType<typeof setTimeout> | undefined;
  let queuedBytes = 0;
  const pending: { id: number; blob: Blob }[] = [];
  let sending = false;
  let sequence = 0;
  const queuedAt = new Map<number, number>();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(keyframeTimer);
    clearInterval(watchdog);
    queuedAt.clear();
    pending.length = 0;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    if (recorder.state !== 'inactive') recorder.stop();
  };
  const failed = (callback: () => void) => {
    if (!stopped) {
      stop();
      callback();
    }
  };
  // Byte limits protect memory; age limits protect conversation latency. Stop a
  // whole video stream, never discard arbitrary chunks from continuous WebM.
  const watchdog =
    options?.onCongestion || options?.onSendError
      ? setInterval(() => {
          const oldest = queuedAt.values().next().value;
          if (oldest !== undefined && performance.now() - oldest > 1500)
            failed(
              options.onCongestion ??
                (() => options.onSendError!(new Error('Call media send queue stalled'))),
            );
        }, 250)
      : undefined;
  recorder.onerror = () => failed(onError);
  // WebKitGTK's VP8 recorder disables periodic keyframes. Renew its video-only
  // recording before the receiver's eight-second buffer discards the first one.
  // GStreamer keeps monotonic timestamps across recordings; ordered WebM init
  // segments can reuse the same MSE player without interrupting the audio track.
  const renewVideo = mimeType === CALL_VIDEO_MIME_TYPE && nativeLinux;
  const scheduleKeyframe = () => {
    if (renewVideo)
      keyframeTimer = setTimeout(() => {
        if (!stopped && recorder.state === 'recording') {
          try {
            recorder.stop();
          } catch {
            failed(onError);
          }
        }
      }, 4000);
  };
  recorder.onstop = () => {
    if (stopped || !renewVideo) return;
    try {
      recorder.start(timeslice);
      scheduleKeyframe();
    } catch {
      failed(onError);
    }
  };
  const pump = async () => {
    if (sending || stopped) return;
    sending = true;
    try {
      while (!stopped && pending.length) {
        // Coalesce only chunks already waiting. WebM is an ordered byte stream;
        // one IPC round trip per chunk otherwise builds lag on native WebViews.
        const batch = pending.splice(0);
        const blob = batch.length === 1 ? batch[0].blob : new Blob(batch.map((p) => p.blob));
        const data = new Uint8Array(await blob.arrayBuffer());
        if (stopped) return;
        const frame = new Uint8Array(data.length + 1);
        frame.set(data, 1);
        await send(frame);
        queuedBytes -= data.length;
        for (const { id } of batch) queuedAt.delete(id);
      }
    } catch (cause) {
      failed(() => (options?.onSendError ? options.onSendError(cause) : onError()));
    } finally {
      sending = false;
    }
  };
  recorder.ondataavailable = (event) => {
    if (stopped || !event.data.size) return;
    queuedBytes += event.data.size;
    // Leave one byte for the lane marker, including when a whole queue is merged.
    if (queuedBytes > 1_048_575) {
      failed(options?.onCongestion ?? onError);
      return;
    }
    const id = sequence++;
    queuedAt.set(id, performance.now());
    pending.push({ id, blob: event.data });
    void pump();
  };
  try {
    recorder.start(timeslice);
    scheduleKeyframe();
  } catch (cause) {
    stop();
    throw cause;
  }
  return stop;
}
