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

// Players call this on timeupdate as well as progress: WebKit may append MSE
// segments without emitting progress, leaving a playing call behind live audio.
export function followCallLive(
  element: HTMLMediaElement | null,
  kind: 'audio' | 'video' = 'video',
) {
  if (!element?.buffered.length || element.seeking) return;
  const latest = element.buffered.length - 1;
  const end = element.buffered.end(latest);
  // Audio can recover closer to live; video (including legacy combined media)
  // retains its existing cushion. Leave headroom for chunk arrival jitter.
  const cushion = kind === 'audio' ? 0.2 : 0.35;
  const threshold = kind === 'audio' ? 0.4 : 0.6;
  if (end - element.currentTime > threshold)
    element.currentTime = Math.max(element.buffered.start(latest), end - cushion);
}

// A stalled WebView can stop emitting both progress and timeupdate. Keep the
// live cursor moving independently, only for the lifetime of a remote player.
export function watchCallLive(
  element: HTMLMediaElement,
  kind: 'audio' | 'video' = 'video',
): () => void {
  const timer = setInterval(() => followCallLive(element, kind), 250);
  return () => clearInterval(timer);
}
