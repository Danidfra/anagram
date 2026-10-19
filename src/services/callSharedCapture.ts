// Clones keep per-peer lifecycle/mute controls isolated. Packet encoders may
// share the room's original source; legacy continuous WebM stays per peer.
const originals = new WeakMap<MediaStreamTrack, MediaStreamTrack>();
export function cloneCallTrack(track: MediaStreamTrack): MediaStreamTrack {
  const clone = track.clone();
  originals.set(clone, originals.get(track) ?? track);
  return clone;
}
export function callCaptureTrack(track: MediaStreamTrack): MediaStreamTrack {
  return originals.get(track) ?? track;
}
