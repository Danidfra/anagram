import { describe, expect, it } from 'vitest';
import { CallAudioJitterBuffer, packAudio, unpackAudio } from '#src/services/callAudioPackets.ts';
const packet = (sequence: number, generation = 1) => ({
  generation,
  sequence: sequence >>> 0,
  timestamp: (sequence * 960) >>> 0,
  opus: new Uint8Array([1, 2, 3]),
});
describe('packet call audio', () => {
  it('round-trips headers and rejects oversized or malformed packets', () => {
    expect(unpackAudio(packAudio(packet(10)))).toEqual(packet(10));
    expect(unpackAudio(new Uint8Array(1101))).toBeNull();
    const frame = packAudio(packet(0));
    frame[1] = 2;
    expect(unpackAudio(frame)).toBeNull();
    expect(() => packAudio({ ...packet(1), opus: new Uint8Array(1100) })).toThrow();
  });
  it('reorders, suppresses duplicates and uses the next packet for in-band FEC', () => {
    const buffer = new CallAudioJitterBuffer();
    buffer.push(packet(0), 0);
    buffer.push(packet(2), 20);
    buffer.push(packet(2), 21);
    expect(buffer.pull(10)).toBeNull();
    expect(buffer.pull(60)?.packet?.sequence).toBe(0);
    expect(buffer.pull(80)).toEqual({ packet: packet(2), fec: true });
    expect(buffer.pull(100)).toEqual({ packet: packet(2), fec: false });
    expect(buffer.stats.duplicate).toBe(1);
    buffer.push(packet(1), 101);
    expect(buffer.stats.late).toBe(1);
  });
  it('bounds replay after a stall and old generations cannot replace the current stream', () => {
    const buffer = new CallAudioJitterBuffer();
    for (let i = 0; i < 1000; i++) buffer.push(packet(i), i < 5 ? i * 20 : 20000);
    expect(buffer.stats.buffered).toBeLessThanOrEqual(24);
    expect(buffer.pull(20100)?.packet?.sequence).toBeGreaterThan(980);
    buffer.push(packet(0, 2), 20200);
    buffer.push(packet(1000, 1), 20220);
    expect(buffer.pull(20400)?.packet?.generation).toBe(2);
  });
  it('recovers after prolonged loss without an ever-growing concealment queue', () => {
    const buffer = new CallAudioJitterBuffer();
    buffer.push(packet(0), 0);
    buffer.pull(40);
    for (let i = 0; i < 100; i++) buffer.pull(60 + i * 20);
    expect(buffer.stats.concealed).toBe(4);
    buffer.push(packet(100), 2100);
    buffer.push(packet(101), 2120);
    expect(buffer.pull(2300)?.packet?.sequence).toBe(100);
  });
  it('handles the sequence wrap and keeps a long, jittery call bounded', () => {
    const buffer = new CallAudioJitterBuffer();
    buffer.push(packet(0xfffffffe), 0);
    buffer.push(packet(0xffffffff), 20);
    buffer.push(packet(0), 40);
    expect(buffer.pull(40)?.packet?.sequence).toBe(0xfffffffe);
    expect(buffer.pull(60)?.packet?.sequence).toBe(0xffffffff);
    expect(buffer.pull(80)?.packet?.sequence).toBe(0);
    for (let i = 1; i < 180000; i++) {
      if (i % 23) buffer.push(packet(i), 80 + i * 20 + (i % 7) * 3);
      buffer.pull(80 + i * 20);
      expect(buffer.stats.buffered).toBeLessThanOrEqual(24);
    }
    expect(buffer.stats.targetMs).toBeLessThanOrEqual(160);
  });
});
