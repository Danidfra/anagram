// Versioned, bounded audio packets. Transport encryption is provided by the
// authenticated Iroh connection; these headers contain no account identifiers.
export const OPUS_CALL_MIME = 'audio/opus;anagram=1';
export const AUDIO_PACKET_KIND = 9;
export const AUDIO_PACKET_SAMPLES = 960;
export const AUDIO_PACKET_MS = 20;
export const MAX_AUDIO_PACKET_BYTES = 1100;
const HEADER = 14;
export interface AudioPacket {
  generation: number;
  sequence: number;
  timestamp: number;
  opus: Uint8Array;
}
export function packAudio(packet: AudioPacket): Uint8Array {
  if (!packet.opus.length || packet.opus.length > MAX_AUDIO_PACKET_BYTES - HEADER)
    throw new Error('Invalid Opus packet size');
  const bytes = new Uint8Array(HEADER + packet.opus.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = AUDIO_PACKET_KIND;
  bytes[1] = 1;
  view.setUint32(2, packet.generation);
  view.setUint32(6, packet.sequence);
  view.setUint32(10, packet.timestamp);
  bytes.set(packet.opus, HEADER);
  return bytes;
}
export function unpackAudio(bytes: Uint8Array): AudioPacket | null {
  if (
    bytes.length <= HEADER ||
    bytes.length > MAX_AUDIO_PACKET_BYTES ||
    bytes[0] !== AUDIO_PACKET_KIND ||
    bytes[1] !== 1
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    generation: view.getUint32(2),
    sequence: view.getUint32(6),
    timestamp: view.getUint32(10),
    opus: bytes.subarray(HEADER),
  };
}
// Signed modular distance also handles the uint32 wrap in long-running calls.
const distance = (a: number, b: number) => (a - b) | 0;

export class CallAudioJitterBuffer {
  private packets = new Map<number, AudioPacket>();
  private generation: number | undefined;
  private expected: number | undefined;
  private newest = 0;
  private startAt = 0;
  private previousArrival: { at: number; timestamp: number } | undefined;
  private lastAdjustment = 0;
  private misses = 0;
  private growthFrames = 0;
  private playing = false;
  readonly stats = {
    received: 0,
    late: 0,
    duplicate: 0,
    concealed: 0,
    fec: 0,
    skipped: 0,
    resets: 0,
    targetMs: 40,
    jitterMs: 0,
    buffered: 0,
  };

  push(packet: AudioPacket, now: number): void {
    if (this.generation !== undefined && distance(packet.generation, this.generation) < 0) return;
    if (this.generation !== packet.generation) {
      this.packets.clear();
      this.generation = packet.generation;
      this.expected = undefined;
      this.previousArrival = undefined;
      this.playing = false;
      this.misses = 0;
      this.growthFrames = 0;
      this.stats.resets++;
    }
    this.stats.received++;
    if (this.expected === undefined) {
      this.expected = packet.sequence;
      this.newest = packet.sequence;
      this.startAt = now;
    }
    if (distance(packet.sequence, this.expected) < 0) {
      this.stats.late++;
      return;
    }
    if (this.packets.has(packet.sequence)) {
      this.stats.duplicate++;
      return;
    }
    if (distance(packet.sequence, this.newest) > 0) {
      if (this.previousArrival) {
        const spacing = distance(packet.timestamp, this.previousArrival.timestamp) / 48;
        const variation = Math.abs(now - this.previousArrival.at - spacing);
        this.stats.jitterMs += (Math.min(variation, 500) - this.stats.jitterMs) / 16;
        const target = Math.min(
          160,
          Math.max(40, Math.ceil((20 + 4 * this.stats.jitterMs) / 20) * 20),
        );
        if (target > this.stats.targetMs || now - this.lastAdjustment >= 2000) {
          if (this.playing && target > this.stats.targetMs)
            this.growthFrames = Math.min(
              6,
              this.growthFrames + (target - this.stats.targetMs) / 20,
            );
          this.stats.targetMs =
            target > this.stats.targetMs ? target : Math.max(target, this.stats.targetMs - 20);
          this.lastAdjustment = now;
        }
      }
      this.newest = packet.sequence;
      this.previousArrival = { at: now, timestamp: packet.timestamp };
    } else if (!this.previousArrival)
      this.previousArrival = { at: now, timestamp: packet.timestamp };
    this.packets.set(packet.sequence, packet);
    // A relay/WebSocket stall must never replay seconds of obsolete speech.
    if (distance(this.newest, this.expected) > 12 || this.packets.size > 24) {
      const next = (this.newest - Math.ceil(this.stats.targetMs / 20)) >>> 0;
      this.stats.skipped += Math.max(0, distance(next, this.expected));
      this.expected = next;
      for (const sequence of this.packets.keys())
        if (distance(sequence, next) < 0) this.packets.delete(sequence);
    }
    this.stats.buffered = this.packets.size;
  }

  pull(now: number): { packet: AudioPacket | null; fec: boolean } | null {
    if (this.expected === undefined) return null;
    if (!this.playing) {
      if (now - this.startAt < this.stats.targetMs || !this.packets.size) return null;
      this.playing = true;
    }
    // Correct accumulated clock drift slowly, without chasing individual arrivals.
    if (
      distance(this.newest, this.expected) * 20 > this.stats.targetMs + 60 &&
      now - this.lastAdjustment > 2000
    ) {
      this.packets.delete(this.expected);
      this.expected = (this.expected + 1) >>> 0;
      this.stats.skipped++;
      this.lastAdjustment = now;
    }
    if (this.growthFrames > 0) {
      this.growthFrames--;
      return { packet: null, fec: false };
    }
    const sequence = this.expected;
    const packet = this.packets.get(sequence);
    this.packets.delete(sequence);
    this.expected = (sequence + 1) >>> 0;
    this.stats.buffered = this.packets.size;
    if (packet) {
      this.misses = 0;
      return { packet, fec: false };
    }
    const next = this.packets.get(this.expected);
    if (next) {
      this.stats.fec++;
      this.misses = 0;
      return { packet: next, fec: true };
    }
    this.stats.concealed++;
    if (++this.misses > 3) {
      this.expected = undefined;
      this.playing = false;
      this.packets.clear();
      this.stats.buffered = 0;
      return null;
    }
    return { packet: null, fec: false };
  }
}
