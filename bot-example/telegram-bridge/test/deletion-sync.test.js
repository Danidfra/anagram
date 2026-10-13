import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'teleproto';
import { DeletionSync, deletionConfig } from '../deletion-sync.js';
import { chat } from './telegram-fixture.js';

import { fakeMTProto } from './mtproto-fixture.js';

function fixture(t, count = 55) {
  const calls = [],
    logs = [],
    saves = [];
  const bot = {
    state: {
      links: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [String(i), { messageId: i + 1 }]),
      ),
    },
    chat,
    telegramId: 123,
    stopped: false,
    log: (message) => logs.push(message),
    save() {
      saves.push(structuredClone(this.state));
    },
    submit: async (_, action) => action(),
    receiveTelegramDeletes: (chatId, ids) => calls.push({ chatId, ids }),
  };
  const client = fakeMTProto();
  const sync = new DeletionSync({ bot, client, token: 'private-token' });
  t.after(() => sync.close());
  return { bot, client, sync, calls, logs, saves };
}

test('deletion sync is optional and validates credentials without exposing their values', () => {
  assert.equal(deletionConfig({}), undefined);
  assert.deepEqual(
    deletionConfig({ TELEGRAM_API_ID: ' 123 ', TELEGRAM_API_HASH: 'a'.repeat(32) }),
    { apiId: 123, apiHash: 'a'.repeat(32) },
  );
  for (const env of [
    { TELEGRAM_API_ID: '123' },
    { TELEGRAM_API_HASH: 'secret' },
    { TELEGRAM_API_ID: '-3', TELEGRAM_API_HASH: 'a'.repeat(32) },
    { TELEGRAM_API_ID: '2147483648', TELEGRAM_API_HASH: 'a'.repeat(32) },
    { TELEGRAM_API_ID: 'secret', TELEGRAM_API_HASH: 'secret' },
  ]) {
    assert.throws(
      () => deletionConfig(env),
      (error) => error.message.startsWith('Configure both') && !error.message.includes('secret'),
    );
  }
});

test('startup checks exactly the latest 50 mapped IDs and deletes only explicit matching MessageEmpty results', async (t) => {
  const f = fixture(t);
  f.client.messages = [
    new Api.MessageEmpty({ id: 54 }),
    new Api.MessageEmpty({
      id: 55,
      peerId: new Api.PeerChannel({ channelId: f.client.channelId }),
    }),
    new Api.MessageEmpty({ id: 53, peerId: new Api.PeerChannel({ channelId: 99n }) }),
    new Api.MessageEmpty({ id: 52, peerId: new Api.PeerUser({ userId: 123n }) }),
    new Api.MessageEmpty({ id: 1 }), // Outside the last 50.
    new Api.MessageEmpty({ id: 999 }), // Not a bridged message.
    new Api.Message({ id: 51, message: 'still exists' }),
  ];
  await f.sync.start();
  assert.ok(f.client.request instanceof Api.channels.GetMessages);
  assert.deepEqual(
    f.client.request.id.map((input) => input.id),
    Array.from({ length: 50 }, (_, i) => 55 - i),
  );
  assert.deepEqual(f.calls, [{ chatId: chat.id, ids: [54, 55] }]);
  assert.deepEqual(f.client.auth, { botAuthToken: 'private-token' });
  assert.equal(f.saves[0].mtprotoSession, 'private-session');
  assert.equal(f.client.watched.options.events, 'deleteChannelMessages');
});

test('live events are filtered by channel and type, including deletes older than the latest 50', async (t) => {
  const f = fixture(t);
  await f.sync.start();
  f.calls.length = 0;
  const deletion = new Api.UpdateDeleteChannelMessages({
    channelId: f.client.channelId,
    messages: [1, 2],
    pts: 9,
    ptsCount: 2,
  });
  await f.client.watched.handler(deletion);
  await f.sync.receive(new Api.UpdateDeleteChannelMessages({ channelId: 99n, messages: [3] }));
  await f.sync.receive(new Api.UpdateDeleteMessages({ messages: [4] }));
  assert.deepEqual(f.calls, [{ chatId: chat.id, ids: [1, 2] }]);
  await f.sync.close();
  await f.sync.receive(deletion);
  assert.equal(f.calls.length, 1);
  assert.ok(f.client.destroyed && f.client.unwatched && f.client.off);
});

test('empty history performs no message lookup', async (t) => {
  const f = fixture(t, 0);
  await f.sync.start();
  assert.equal(f.client.request, undefined);
  assert.equal(f.calls.length, 0);
});

test('permission and network errors never cause deletion, and diagnostics omit secrets', async (t) => {
  const f = fixture(t);
  f.client.invoke = async () => {
    throw new Error('private-token private-session secret-hash');
  };
  await assert.rejects(f.sync.start());
  assert.equal(f.calls.length, 0);
  await f.client.onError(new Error('private-token'));
  f.client.errorHandler(new Error('private-session'));
  assert.ok(f.logs.length > 0);
  assert.ok(f.logs.every((log) => !/private-|secret-hash/.test(log)));
  f.client.entity.left = true;
  await assert.rejects(f.sync.reconcile());
  assert.equal(f.calls.length, 0);
});

test('saved session must belong to the same bot, and resolved group must have the same ID', async (t) => {
  const f = fixture(t);
  f.client.getMe = async () => ({ id: 999n, bot: true });
  await assert.rejects(f.sync.start(), /Saved MTProto session/);
  assert.equal(f.saves.length, 0);
  f.client.getMe = async () => ({ id: 123n, bot: false });
  await assert.rejects(f.sync.start(), /Saved MTProto session/);
  f.client.getMe = async () => ({ id: 123n, bot: true });
  f.client.entity.id = 999n;
  await assert.rejects(f.sync.start(), /TELEGRAM_CHAT/);
  assert.equal(f.calls.length, 0);
});

test('reconciliation cannot delete after shutdown during a pending lookup', async (t) => {
  const f = fixture(t);
  await f.sync.start();
  f.calls.length = 0;
  let release;
  const response = new Promise((resolve) => {
    release = resolve;
  });
  f.client.invoke = () => response;
  const pending = f.sync.reconcile();
  await Promise.resolve();
  const closing = f.sync.close();
  release({ messages: [new Api.MessageEmpty({ id: 55 })] });
  await Promise.all([pending, closing]);
  assert.equal(f.calls.length, 0);
});
