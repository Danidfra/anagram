// URLs are local handles, never network addresses. Keeping one media element
// preserves autoplay permission, sink selection and mobile audio routing.
const streams = new Map<string, MediaStream>();
export function registerCallStream(stream: MediaStream): { url: string; close(): void } {
  const url = `anagram-call:${crypto.randomUUID()}`;
  streams.set(url, stream);
  return {
    url,
    close() {
      streams.delete(url);
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
export function getCallStream(url: string): MediaStream | undefined {
  return streams.get(url);
}
export function attachCallMedia(element: HTMLMediaElement, url: string): void {
  const stream = getCallStream(url);
  element.srcObject = stream ?? null;
  if (stream || !url) element.removeAttribute('src');
  else element.src = url;
}
