import { createCallRoomRuntime } from '#src/stores/nostr/callRoomRuntime.ts';
import {
  type CallRoomLink,
  type CallRoomMember,
  type CallRoomSignal,
  ROOM_PROTOCOL,
} from '#src/types/callRoom.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

class Track {
  enabled = true;
  readyState = 'live';
  onended: (() => void) | null = null;
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
  constructor(public kind: string) {}
  clone() {
    const copy = new Track(this.kind);
    copy.enabled = this.enabled;
    return copy;
  }
  getSettings() {
    return { deviceId: this.kind };
  }
}
class Stream {
  constructor(private tracks: Track[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
  clone() {
    return new Stream(this.tracks.map((track) => track.clone()));
  }
}
vi.stubGlobal('MediaStream', Stream);
const runtimes: ReturnType<typeof createCallRoomRuntime>[] = [];
function setup(own = 'a'.repeat(64)) {
  const microphone = new Track('audio');
  const stream = new MediaStream([microphone] as unknown as MediaStreamTrack[]);
  const deps = {
    getOwnPubkey: () => own,
    getIdentity: async () => ({ name: 'Alice', relays: ['wss://relay.example'] }),
    isBlocked: vi.fn(() => false),
    otherCallBusy: vi.fn(() => false),
    send: vi.fn().mockResolvedValue(undefined),
    media: {
      supported: () => true,
      getScreen: vi.fn<() => Promise<MediaStream>>(),
      getMedia: vi.fn().mockResolvedValue(stream),
      getMicrophone: vi.fn().mockResolvedValue(stream),
      getCamera: vi
        .fn()
        .mockResolvedValue(new MediaStream([new Track('video')] as unknown as MediaStreamTrack[])),
      createEndpoint: vi.fn(async () => ({
        id: () => 'a'.repeat(64),
        relay_url: () => 'https://relay.example/',
        online: async () => {},
        close: vi.fn().mockResolvedValue(undefined),
        connect: () => new Promise<never>(() => {}),
        accept: () => new Promise<never>(() => {}),
      })),
      createReceiver: () => ({ url: 'blob:media', append: vi.fn(), close: vi.fn() }),
      record: vi.fn(() => vi.fn()),
    },
  };
  const runtime = createCallRoomRuntime(deps);
  runtimes.push(runtime);
  return { runtime, deps, microphone, stream };
}
function signal(link: CallRoomLink, body: Partial<CallRoomSignal>): CallRoomSignal {
  return {
    protocol: ROOM_PROTOCOL,
    action: 'leave',
    roomId: link.id,
    senderSession: link.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...body,
  };
}
function join(link: CallRoomLink, pubkey = 'b'.repeat(64)): CallRoomSignal {
  const member: CallRoomMember = {
    pubkey,
    sessionId: crypto.randomUUID(),
    name: 'Guest',
    relays: ['wss://guest.example'],
  };
  return signal(link, {
    action: 'join',
    senderSession: member.sessionId,
    member,
    secret: link.secret,
  });
}
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => {
    runtime.reset();
  });
  vi.useRealTimers();
});

describe('link-based Iroh call rooms', () => {
  it.each([
    'stop',
    'leave',
  ])('discards a pending screen picker after %s and allows another share', async (action) => {
    const h = setup();
    await h.runtime.create();
    let resolve!: (stream: MediaStream) => void;
    h.deps.media.getScreen.mockImplementationOnce(
      () =>
        new Promise((yes) => {
          resolve = yes;
        })
    );
    const pending = h.runtime.startScreenSharing();
    if (action === 'leave') {
      h.runtime.leave();
      await h.runtime.create();
    } else await h.runtime.stopScreenSharing();
    const newTrack = new Track('video');
    const current = new MediaStream([newTrack] as unknown as MediaStreamTrack[]);
    h.deps.media.getScreen.mockResolvedValueOnce(current);
    await h.runtime.startScreenSharing();
    const oldTrack = new Track('video');
    resolve(new MediaStream([oldTrack] as unknown as MediaStreamTrack[]));
    await pending;
    expect(h.runtime.localScreenStream.value).toBe(current);
    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(newTrack.stop).not.toHaveBeenCalled();
  });
  it('selects cameras without unmuting and replaces capture without stopping the microphone', async () => {
    const h = setup();
    await h.runtime.create();
    await h.runtime.selectCamera('camera-2');
    expect(h.deps.media.getCamera).not.toHaveBeenCalled();
    expect(h.runtime.cameraMuted.value).toBe(true);
    await h.runtime.toggleCamera();
    expect(h.deps.media.getCamera).toHaveBeenLastCalledWith('camera-2');
    const previous = h.runtime.localStream.value?.getVideoTracks()[0];
    h.deps.media.getCamera.mockRejectedValueOnce(new DOMException('Busy', 'NotReadableError'));
    await h.runtime.selectCamera('busy');
    expect(previous?.stop).not.toHaveBeenCalled();
    const camera = new Track('video');
    camera.getSettings = () => ({ deviceId: 'camera-3' });
    h.deps.media.getCamera.mockResolvedValueOnce(
      new MediaStream([camera] as unknown as MediaStreamTrack[])
    );
    await h.runtime.selectCamera('camera-3');
    expect(previous?.stop).toHaveBeenCalledOnce();
    expect(h.runtime.cameraDeviceId.value).toBe('camera-3');
    expect(h.microphone.stop).not.toHaveBeenCalled();
    expect(h.runtime.busy.value).toBe(true);
  });
  it('reserves one room and captures input only once, then closes all tracks', async () => {
    const h = setup();
    await Promise.all([h.runtime.create(), h.runtime.create()]);
    expect(h.deps.media.getMedia).toHaveBeenCalledOnce();
    expect(h.runtime.session.value?.phase).toBe('active');
    expect(h.runtime.session.value?.link.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(h.runtime.session.value?.members).toHaveLength(1);
    h.runtime.leave();
    expect(h.microphone.stop).toHaveBeenCalledOnce();
    expect(h.runtime.localStream.value).toBeNull();
  });
  it('shares each participant’s own chosen name through join and roster controls', async () => {
    const host = setup();
    const guest = setup('b'.repeat(64));
    host.deps.getIdentity = async () => ({ name: 'Host chosen name', relays: ['wss://relay.example'] });
    guest.deps.getIdentity = async () => ({ name: 'Guest chosen name', relays: ['wss://relay.example'] });
    await host.runtime.create();
    const link = host.runtime.session.value!.link;
    await guest.runtime.join(link);
    const request = guest.deps.send.mock.calls.find(([, body]) => body.action === 'join')![1];
    expect(request.member.name).toBe('Guest chosen name');
    expect(Object.keys(request.member).sort()).toEqual(['name', 'pubkey', 'relays', 'sessionId']);
    await host.runtime.receive('b'.repeat(64), request);
    const roster = host.deps.send.mock.calls.find(([, body]) => body.action === 'roster')![1];
    await guest.runtime.receive(link.host, roster);
    expect(host.runtime.session.value!.members.map((member) => member.name)).toEqual([
      'Host chosen name',
      'Guest chosen name',
    ]);
    expect(guest.runtime.session.value!.members).toEqual(host.runtime.session.value!.members);
    expect(JSON.stringify(roster)).not.toContain('css');
  });
  it.each([false, true])(
    'creates a unique room after leaving (dismiss: %s) and rejects old invitations',
    async (dismiss) => {
      const h = setup();
      await h.runtime.create();
      const first = h.runtime.session.value!.link;
      const oldJoin = join(first);
      h.runtime.leave();
      if (dismiss) h.runtime.dismiss();
      // A new getUserMedia request returns fresh tracks, not the stopped first stream.
      h.deps.media.getMedia.mockResolvedValueOnce(
        new MediaStream([new Track('audio')] as unknown as MediaStreamTrack[]),
      );
      await h.runtime.create();
      expect(h.runtime.session.value!.phase).toBe('active');
      const second = h.runtime.session.value!.link;
      expect(second.id).not.toBe(first.id);
      expect(second.secret).not.toBe(first.secret);
      expect(h.runtime.session.value!.own.sessionId).not.toBe(first.id);
      await h.runtime.receive('b'.repeat(64), oldJoin);
      expect(h.runtime.session.value!.members).toHaveLength(1);
      await h.runtime.receive('b'.repeat(64), { ...join(second), secret: first.secret });
      expect(h.runtime.session.value!.members).toHaveLength(1);
      await h.runtime.receive('b'.repeat(64), join(second));
      expect(h.runtime.session.value!.members).toHaveLength(2);
    },
  );
  it('shares live host and guest name edits without restarting media or accepting stale/spoofed edits', async () => {
    const host = setup(),
      guest = setup('b'.repeat(64)),
      observer = setup('c'.repeat(64));
    await host.runtime.create();
    const link = host.runtime.session.value!.link;
    for (const user of [guest, observer]) {
      await user.runtime.join(link);
      await host.runtime.receive(
        user.deps.getOwnPubkey(),
        user.deps.send.mock.calls.find(([, body]) => body.action === 'join')![1],
      );
    }
    const deliverRosters = async () => {
      for (const user of [guest, observer]) {
        const call = host.deps.send.mock.calls
          .filter(([to, body]) => to === user.deps.getOwnPubkey() && body.action === 'roster')
          .at(-1)!;
        await user.runtime.receive(link.host, call[1]);
      }
    };
    await deliverRosters();
    await vi.waitFor(() => expect(host.deps.media.createEndpoint).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(guest.deps.media.createEndpoint).toHaveBeenCalledTimes(1));
    const endpointCounts = [host, guest, observer].map(
      (user) => user.deps.media.createEndpoint.mock.calls.length,
    );
    const streams = [host, guest, observer].map((user) => user.runtime.localStream.value);
    const latestJoin = () =>
      guest.deps.send.mock.calls.filter(([, body]) => body.action === 'join').at(-1)![1];
    await guest.runtime.updateName('Guest first');
    const older = latestJoin();
    await guest.runtime.updateName('Guest latest');
    const latest = latestJoin();
    await host.runtime.receive(guest.deps.getOwnPubkey(), latest);
    await deliverRosters();
    for (const user of [host, observer])
      expect(
        user.runtime.participants.value.find((member) => member.pubkey === guest.deps.getOwnPubkey())
          ?.name,
      ).toBe('Guest latest');
    expect(guest.runtime.session.value!.own.name).toBe('Guest latest');
    await host.runtime.receive(guest.deps.getOwnPubkey(), older);
    await host.runtime.receive(observer.deps.getOwnPubkey(), {
      ...latest,
      member: { ...latest.member!, name: 'Spoofed', nameRevision: 100 },
    });
    expect(
      host.runtime.participants.value.find((member) => member.pubkey === guest.deps.getOwnPubkey())
        ?.name,
    ).toBe('Guest latest');
    await host.runtime.updateName('Host changed');
    await deliverRosters();
    for (const user of [guest, observer])
      expect(
        user.runtime.participants.value.find((member) => member.pubkey === link.host)?.name,
      ).toBe('Host changed');
    for (const [index, user] of [host, guest, observer].entries()) {
      expect(user.runtime.localStream.value).toBe(streams[index]);
      expect(user.deps.media.createEndpoint).toHaveBeenCalledTimes(endpointCounts[index]);
      expect(user.deps.media.getMedia).toHaveBeenCalledOnce();
      expect(user.microphone.stop).not.toHaveBeenCalled();
      expect(user.runtime.session.value!.phase).toBe('active');
    }
  });
  it('ignores a delayed name lookup after leaving the call', async () => {
    const h = setup();
    await h.runtime.create();
    let finish!: (identity: { name: string; relays: string[] }) => void;
    h.deps.getIdentity = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = h.runtime.updateName('');
    h.runtime.leave();
    finish({ name: 'Too late', relays: ['wss://relay.example'] });
    await pending;
    expect(h.runtime.session.value!.own.name).toBe('Alice');
    expect(h.runtime.session.value!.phase).toBe('ended');
  });
  it('requires the link secret and authenticated joining identity', async () => {
    const h = setup();
    await h.runtime.create();
    const link = h.runtime.session.value?.link;
    const request = join(link);
    await h.runtime.receive('b'.repeat(64), { ...request, secret: 'f'.repeat(64) });
    await h.runtime.receive('c'.repeat(64), request);
    expect(h.runtime.session.value?.members).toHaveLength(1);
    await h.runtime.receive('b'.repeat(64), request);
    expect(h.runtime.session.value?.members).toHaveLength(2);
    expect(h.deps.send).toHaveBeenCalledWith(
      'b'.repeat(64),
      expect.objectContaining({ action: 'roster', revision: 2 }),
      ['wss://guest.example']
    );
  });
  it('caps rooms at six members and ignores blocked users even with the link', async () => {
    const h = setup();
    await h.runtime.create();
    const link = h.runtime.session.value?.link;
    h.deps.isBlocked.mockReturnValueOnce(true);
    await h.runtime.receive('b'.repeat(64), join(link));
    expect(h.runtime.session.value?.members).toHaveLength(1);
    for (const digit of ['b', 'c', 'd', 'e', 'f'])
      await h.runtime.receive(digit.repeat(64), join(link, digit.repeat(64)));
    const extra = '1'.repeat(64);
    await h.runtime.receive(extra, join(link, extra));
    expect(h.runtime.session.value?.members).toHaveLength(6);
    expect(h.deps.send).toHaveBeenCalledWith(
      extra,
      expect.objectContaining({ action: 'rejected', reason: 'full' }),
      ['wss://guest.example']
    );
  });
  it('accepts membership only from the host and ignores older roster revisions', async () => {
    const h = setup('b'.repeat(64));
    const link = {
      id: crypto.randomUUID(),
      host: 'a'.repeat(64),
      secret: 'c'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      relays: ['wss://relay.example'],
    };
    await h.runtime.join(link);
    const own = h.runtime.session.value?.own;
    const host = { pubkey: link.host, sessionId: link.id, name: 'Host', relays: link.relays };
    const roster = signal(link, { action: 'roster', members: [host, own], revision: 2 });
    await h.runtime.receive('d'.repeat(64), roster);
    expect(h.runtime.session.value?.phase).toBe('joining');
    await h.runtime.receive(link.host, roster);
    expect(h.runtime.session.value?.phase).toBe('active');
    await h.runtime.receive(link.host, { ...roster, revision: 1, members: [host] });
    expect(h.runtime.session.value?.phase).toBe('active');
    expect(h.runtime.session.value?.members).toHaveLength(2);
    await h.runtime.receive(link.host, signal(link, { action: 'closed' }));
    expect(h.runtime.session.value?.phase).toBe('ended');
    expect(h.microphone.stop).toHaveBeenCalled();
  });
  it('ignores stale joins and departures after a participant rejoins', async () => {
    const h = setup();
    await h.runtime.create();
    const link = h.runtime.session.value?.link;
    const first = join(link);
    const second = join(link);
    await h.runtime.receive('b'.repeat(64), first);
    await h.runtime.receive('b'.repeat(64), second);
    await h.runtime.receive('b'.repeat(64), first);
    expect(h.runtime.session.value?.members[1]?.sessionId).toBe(second.senderSession);
    await h.runtime.receive(
      'b'.repeat(64),
      signal(link, { action: 'leave', senderSession: first.senderSession })
    );
    expect(h.runtime.session.value?.members).toHaveLength(2);
    await h.runtime.receive(
      'b'.repeat(64),
      signal(link, { action: 'leave', senderSession: second.senderSession })
    );
    expect(h.runtime.session.value?.members).toHaveLength(1);
    await h.runtime.receive('b'.repeat(64), second);
    expect(h.runtime.session.value?.members).toHaveLength(1);
    expect(h.microphone.stop).not.toHaveBeenCalled();
  });
  it('cleans up capture which completes after cancellation', async () => {
    const h = setup();
    let complete: (stream: MediaStream) => void = () => {};
    h.deps.media.getMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const starting = h.runtime.create();
    h.runtime.leave();
    complete(h.stream);
    await starting;
    expect(h.microphone.stop).toHaveBeenCalledOnce();
    expect(h.runtime.localStream.value).toBeNull();
    expect(h.deps.send).not.toHaveBeenCalled();
  });
  it('times out joining an offline host and releases media', async () => {
    vi.useFakeTimers();
    const h = setup('b'.repeat(64));
    await h.runtime.join({
      id: crypto.randomUUID(),
      host: 'a'.repeat(64),
      secret: 'c'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      relays: ['wss://relay.example'],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.runtime.error.value).toBe('room.error.timeout');
    expect(h.microphone.stop).toHaveBeenCalled();
    expect(h.runtime.busy.value).toBe(false);
  });
  it('refuses starting a room during another call', async () => {
    const h = setup();
    h.deps.otherCallBusy.mockReturnValue(true);
    await h.runtime.create();
    expect(h.runtime.error.value).toBe('room.error.busy');
    expect(h.deps.media.getMedia).not.toHaveBeenCalled();
  });
});
