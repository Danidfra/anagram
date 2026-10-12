import { it } from 'vitest';
import { execFileSync } from 'node:child_process';

// Run Node-only release tooling outside Vite's browser module resolution.
it('release smoke waits for the live inbox, not unrelated reconnect requests', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import WebSocket from 'ws';
    import { startRelay } from './scripts/release-smoke/relay.mjs';
    const relay = await startRelay();
    async function connect() {
      const socket = new WebSocket(relay.url);
      await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      return socket;
    }
    async function subscribe(socket, id, filter) {
      const eose = new Promise(resolve => {
        const listener = data => {
          const message = JSON.parse(data.toString());
          if (message[0] === 'EOSE' && message[1] === id) {
            socket.off('message', listener);
            resolve();
          }
        };
        socket.on('message', listener);
      });
      socket.send(JSON.stringify(['REQ', id, filter]));
      await eose;
    }
    try {
      let socket = await connect();
      for (const [id, filter] of Object.entries({
        profile: { kinds: [0], authors: [relay.pubkey] },
        history: { kinds: [1059], '#p': [relay.pubkey], until: Math.floor(Date.now()/1000) },
        other: { kinds: [1059], '#p': ['f'.repeat(64)] },
      })) {
        await subscribe(socket, id, filter);
        assert.ok(relay.stats.requests > 0); // Old check incorrectly passes.
        assert.equal(relay.hasLiveInboxSubscription(), false);
      }
      await subscribe(socket, 'old-inbox', { kinds: [1059], '#p': [relay.pubkey] });
      assert.equal(relay.hasLiveInboxSubscription(), true);
      relay.disconnect();
      assert.equal(relay.hasLiveInboxSubscription(), false);
      socket = await connect();
      await subscribe(socket, 'profile', { kinds: [0] });
      assert.equal(relay.hasLiveInboxSubscription(), false);
      await subscribe(socket, 'new-inbox', { kinds: [1059], '#p': [relay.pubkey] });
      assert.equal(relay.hasLiveInboxSubscription(), true);
      const delivered = new Promise(resolve => socket.once('message', data => resolve(JSON.parse(data.toString()))));
      relay.deliver('after reconnect');
      const message = await delivered;
      assert.deepEqual(message.slice(0, 2), ['EVENT', 'new-inbox']);
      assert.equal(message[2].kind, 1059);
      socket.send(JSON.stringify(['CLOSE', 'new-inbox']));
      await subscribe(socket, 'barrier', { kinds: [0] });
      assert.equal(relay.hasLiveInboxSubscription(), false);
    } finally { await relay.close(); }
  `,
    ],
    { timeout: 10000 },
  );
}, 15000);
