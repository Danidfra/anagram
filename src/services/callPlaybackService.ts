// Reuse one audio element across negotiation, microphone changes and camera toggles.
// Input permission does not grant permission to autoplay a newly created media element.
let audio: HTMLAudioElement | null = null;
const SILENCE =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
export function registerCallAudio(element: HTMLAudioElement | null): void {
  audio = element;
}
export function primeCallAudio(): void {
  if (!audio || audio.src.startsWith('blob:')) return;
  audio.src = SILENCE;
  audio.muted = false;
  void audio.play().catch(() => {});
}
export async function setCallSpeaker(element: HTMLMediaElement, deviceId: string): Promise<void> {
  if (typeof element.setSinkId !== 'function') {
    if (!deviceId) return;
    throw new Error('Audio output selection is unavailable in this browser');
  }
  await element.setSinkId(deviceId);
}

export function followCallLive(element: HTMLMediaElement | null) {
  if (!element?.buffered.length || element.seeking) return;
  const latest = element.buffered.length - 1;
  const end = element.buffered.end(latest);
  // Recover from brief stalls while retaining the existing 350 ms playback cushion.
  if (end - element.currentTime > 0.6)
    element.currentTime = Math.max(element.buffered.start(latest), end - 0.35);
}
