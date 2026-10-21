import { isTauri } from '@tauri-apps/api/core';
import { callCaptureTrack } from './callSharedCapture.ts';
import type { CallRecordingOptions } from './callMediaService.ts';
import { CALL_MIME_TYPES, CALL_VIDEO_MIME_TYPE } from '#src/utils/callSignal.ts';

type Listener = { chunk(blob: Blob): void; reset(): void; error(): void; ready: boolean };
type Capture = { listeners: Set<Listener>; restart(): void; close(): void };
const captures = new WeakMap<MediaStreamTrack, Map<string, Capture>>();

// Only split streams with an ordered receiver-reset callback can share. A late
// join restarts the capture once for everyone; no partial WebM header replay.
export function subscribeLegacyCapture(
  stream: MediaStream,
  mimeType: string,
  options: CallRecordingOptions | undefined,
  callbacks: Omit<Listener, 'ready'>,
): () => void {
  const tracks = stream.getTracks?.() ?? [];
  const original =
    tracks.length === 1 && options?.onStreamRestart ? callCaptureTrack(tracks[0]) : undefined;
  const key = `${mimeType}:${options?.videoBitsPerSecond ?? 600000}:${options?.videoFrameRate ?? 24}:${options?.videoMaxWidth ?? 0}:${options?.videoMaxHeight ?? 0}`;
  let profiles = original ? captures.get(original) : undefined;
  if (original && !profiles) {
    profiles = new Map();
    captures.set(original, profiles);
  }
  let capture = profiles?.get(key);
  const listener: Listener = { ...callbacks, ready: !capture };
  if (!capture) {
    const listeners = new Set([listener]);
    let recorder: MediaRecorder;
    let closed = false;
    let joining: ReturnType<typeof setTimeout> | undefined;
    let keyframe: ReturnType<typeof setTimeout> | undefined;
    const timeslice = mimeType === CALL_MIME_TYPES[1] ? 50 : 100;
    const renewVideo =
      mimeType === CALL_VIDEO_MIME_TYPE &&
      isTauri() &&
      /Linux/.test(navigator.userAgent) &&
      !/Android/.test(navigator.userAgent);
    const fail = () => {
      for (const peer of [...listeners]) peer.error();
    };
    const stopRecorder = () => {
      if (!recorder) return;
      recorder.ondataavailable = recorder.onerror = recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
    };
    const scheduleKeyframe = () => {
      if (renewVideo)
        keyframe = setTimeout(() => {
          try {
            if (!closed && recorder.state === 'recording') recorder.stop();
          } catch {
            fail();
          }
        }, 4000);
    };
    const start = () => {
      recorder = new MediaRecorder(original ? new MediaStream([original]) : stream, {
        mimeType,
        audioBitsPerSecond: 32000,
        videoBitsPerSecond: options?.videoBitsPerSecond ?? 600000,
      });
      recorder.ondataavailable = (event) => {
        if (!closed && event.data.size)
          for (const peer of [...listeners]) if (peer.ready) peer.chunk(event.data);
      };
      recorder.onerror = fail;
      recorder.onstop = () => {
        if (closed || !renewVideo) return;
        try {
          recorder.start(timeslice);
          scheduleKeyframe();
        } catch {
          fail();
        }
      };
      recorder.start(timeslice);
      scheduleKeyframe();
    };
    capture = {
      listeners,
      restart() {
        if (joining !== undefined) return;
        joining = setTimeout(() => {
          joining = undefined;
          if (closed) return;
          clearTimeout(keyframe);
          try {
            stopRecorder();
            for (const peer of [...listeners]) {
              peer.reset();
              peer.ready = true;
            }
            if (!closed) start();
          } catch {
            fail();
          }
        }, 100);
      },
      close() {
        closed = true;
        clearTimeout(joining);
        clearTimeout(keyframe);
        stopRecorder();
        profiles?.delete(key);
      },
    };
    profiles?.set(key, capture);
    try {
      start();
    } catch (error) {
      capture.close();
      throw error;
    }
  } else {
    capture.listeners.add(listener);
    capture.restart();
  }
  const active = capture;
  return () => {
    active.listeners.delete(listener);
    if (!active.listeners.size) active.close();
  };
}
