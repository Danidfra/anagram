import { describe, expect, it, vi } from 'vitest';
import { adaptCallEndpoint, mergeCallLanes } from '#src/services/callTransportLanes.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe('independent call transport streams', () => {
  it('delivers readiness first, then audio and heartbeats while video is blocked, without read-ahead', async () => {
    const lanes = Array.from({ length: 4 }, () => deferred<Uint8Array>());
    const raw = {
      send: vi.fn(),
      close: vi.fn(),
      recv: vi.fn(),
      recv_lane: vi.fn((lane: number) => lanes[lane].promise),
    };
    const connection = mergeCallLanes(raw);
    const ready = connection.recv();
    expect(raw.recv_lane.mock.calls).toEqual([[0]]);
    lanes[0].resolve(new Uint8Array([2]));
    await expect(ready).resolves.toEqual(new Uint8Array([2]));
    lanes[0] = deferred();
    const audio = connection.recv();
    lanes[1].resolve(new Uint8Array([0, 42]));
    await expect(audio).resolves.toEqual(new Uint8Array([0, 42]));
    lanes[1] = deferred();
    const heartbeat = connection.recv();
    lanes[0].resolve(new Uint8Array([1]));
    await expect(heartbeat).resolves.toEqual(new Uint8Array([1]));
    expect(raw.recv_lane.mock.calls.filter(([lane]) => lane === 2)).toHaveLength(1);
    expect(raw.recv_lane.mock.calls.filter(([lane]) => lane === 3)).toHaveLength(1);
    connection.close();
    await expect(connection.recv()).rejects.toThrow('closed');
  });
  it('keeps the legacy transport when newer bindings or negotiation are absent', async () => {
    const connection = { send: vi.fn(), recv: vi.fn(), close: vi.fn() };
    const raw = {
      online: vi.fn(),
      id: () => 'id',
      relay_url: () => 'relay',
      close: vi.fn(),
      connect: vi.fn().mockResolvedValue(connection),
      accept: vi.fn().mockResolvedValue(connection),
    };
    const endpoint = adaptCallEndpoint(raw);
    expect(endpoint.multiplexed).toBe(false);
    expect(await endpoint.connect('peer', 'relay', 'call', true)).toBe(connection);
    expect(raw.connect).toHaveBeenCalledWith('peer', 'relay', 'call');
  });
});
