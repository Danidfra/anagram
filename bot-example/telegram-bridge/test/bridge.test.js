import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';
import { TelegramBridge } from '../bridge.js';
import { Network, State, now, sign } from '../runtime.js';
import { Telegram, TelegramError, escapeHTML, replyParts } from '../telegram.js';
import { relay, until } from './relay.js';

import { chat, FakeTelegram } from './telegram-fixture.js';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-bridge-'));
  const store = new State(dir);
  const owner = generateSecretKey();
  const author = generateSecretKey();
  const telegram = new FakeTelegram();
  const published = [];
  const net = {
    configured: ['wss://example.org'],
    query: async () => [],
    watch: () => () => {},
    close() {},
    publish: async (event) => {
      published.push(event);
    },
  };
  const publicGroup = nip19.naddrEncode({
    kind: 34550,
    pubkey: getPublicKey(owner),
    identifier: 'test',
    relays: net.configured,
  });
  const bot = new TelegramBridge({
    store,
    net,
    telegram,
    publicGroup,
    telegramChat: '@public_test',
    log() {},
  });
  bot.chat = chat;
  bot.telegramId = 123;
  const room = (tags = [], timestamp = now()) =>
    sign(
      owner,
      34550,
      [
        ['d', 'test'],
        ['name', 'Test'],
        ['anagram-room', '1'],
        ['relay', net.configured[0]],
        ...tags,
      ],
      '',
      timestamp,
    );
  bot.acceptRoom(room([['trusted', bot.pubkey]]));
  const update = (overrides = {}, id = 10) => ({
    update_id: id,
    message: {
      message_id: 42,
      date: now(),
      chat,
      from: { id: 456, first_name: 'Alice', last_name: 'Smith' },
      text: 'Hello <everyone> & friends',
      ...overrides,
    },
  });
  const reply = (id) =>
    sign(
      author,
      9,
      [
        ['a', bot.address],
        ['q', id, '', bot.pubkey],
      ],
      'Hi <Alice> & "friends"',
      now(),
    );
  t.after(async () => {
    await bot.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    bot,
    store,
    owner,
    author,
    telegram,
    net,
    published,
    update,
    reply,
    room,
    dir,
    publicGroup,
  };
}

test('Telegram messages publish the exact requested format and persist the parent mapping before publish', async (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update({ message_thread_id: 7 }));
  const item = f.store.data.outbox[0];
  assert.equal(item.event.content, 'Alice Smith said:\n"Hello <everyone> & friends"');
  assert.deepEqual(item.event.tags, [
    ['a', f.bot.address],
    ['telegram', String(chat.id), '42'],
  ]);
  const disk = JSON.parse(readFileSync(f.store.file));
  assert.equal(disk.links[item.event.id].messageId, 42);
  assert.equal(disk.offset, 11);
  f.bot.receiveTelegram(f.update());
  assert.equal(f.store.data.outbox.length, 1);
  await f.bot.flush();
  assert.equal(f.published[0].id, item.event.id);
  assert.equal(f.store.data.outbox.length, 0);
});

test('only a direct signed reply is sent as a Telegram reply, with escaped name/text and group link', async (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update({ message_thread_id: 7 }));
  const parent = f.store.data.outbox[0].event.id;
  f.net.query = async () => [sign(f.author, 0, [], JSON.stringify({ display_name: 'Ben <B>' }))];
  const event = f.reply(parent);
  await f.bot.receiveReply(event);
  await f.bot.receiveReply(event);
  await f.bot.flush();
  const sends = f.telegram.calls.filter((call) => call.method === 'sendMessage');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].body.reply_parameters, {
    message_id: 42,
    allow_sending_without_reply: false,
  });
  assert.equal(sends[0].body.message_thread_id, 7);
  assert.equal(
    sends[0].body.text,
    `Ben &lt;B&gt; replied:\n&quot;Hi &lt;Alice&gt; &amp; &quot;friends&quot;"\nJoin the group at <a href="${f.bot.link}">anagram.chat</a>`,
  );
  assert.equal(sends[0].body.parse_mode, 'HTML');
});

test('ignores DMs, private groups, ordinary posts, mentions, forged events, wrong-room replies, edits and self echoes', async (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update());
  const parent = f.store.data.outbox[0].event.id;
  const tags = [
    ['a', f.bot.address],
    ['q', parent, '', f.bot.pubkey],
  ];
  for (const event of [
    sign(f.author, 14, tags, 'private'),
    sign(f.author, 1059, tags, 'wrapped'),
    sign(
      f.author,
      9,
      [
        ['a', f.bot.address],
        ['p', f.bot.pubkey],
      ],
      'mention',
    ),
    sign(
      f.author,
      9,
      [
        ['a', 'wrong'],
        ['q', parent],
      ],
      'wrong room',
    ),
    sign(
      f.author,
      9,
      [
        ['a', f.bot.address],
        ['q', 'a'.repeat(64)],
      ],
      'unmapped',
    ),
    sign(f.author, 9, [...tags, ['q', parent]], 'ambiguous'),
    sign(f.author, 9, [...tags, ['e', 'a'.repeat(64), '', 'edit']], 'edit'),
    sign(f.bot.key, 9, tags, 'self'),
    { ...f.reply(parent), content: 'forged' },
  ])
    await f.bot.receiveReply(event);
  assert.equal(f.store.data.outbox.length, 1);
});

test('rejects nonpublic Telegram messages, old updates, service updates, protected messages and bot echoes', (t) => {
  const f = fixture(t);
  let id = 10;
  for (const overrides of [
    { chat: { ...chat, type: 'private' } },
    { chat: { ...chat, id: -100999 } },
    { chat: { ...chat, username: undefined } },
    { has_protected_content: true },
    { date: f.store.data.startedAt - 1 },
    { from: { id: 123 } },
    { text: undefined, new_chat_members: [{ id: 99 }] },
  ])
    f.bot.receiveTelegram(f.update(overrides, id++));
  assert.equal(f.store.data.outbox.length, 0);
});

test('media captions and media-only messages include a public source link', (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update({ text: undefined, photo: [{}], caption: 'A photo' }));
  assert.equal(
    f.store.data.outbox[0].event.content,
    'Alice Smith said:\n"A photo\n[photo] https://t.me/public_test/42"',
  );
});

test('owner must trust the bot; removing or blocking it stops both directions and pending deliveries', async (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update());
  const parent = f.store.data.outbox[0].event.id;
  f.bot.acceptRoom(f.room([], now() + 1));
  assert.equal(f.bot.active, false);
  f.bot.receiveTelegram(f.update({}, 11));
  await f.bot.receiveReply(f.reply(parent));
  await f.bot.flush();
  assert.equal(f.published.length, 0);
  assert.equal(f.store.data.outbox.length, 0);
  f.bot.acceptRoom(
    f.room(
      [
        ['trusted', f.bot.pubkey],
        ['blocked', f.bot.pubkey],
      ],
      now() + 2,
    ),
  );
  assert.equal(f.bot.active, false);
});

test('blocked authors cannot send replies even when delivery was previously queued', async (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update());
  await f.bot.receiveReply(f.reply(f.store.data.outbox[0].event.id));
  f.bot.acceptRoom(
    f.room(
      [
        ['trusted', f.bot.pubkey],
        ['blocked', getPublicKey(f.author)],
      ],
      now() + 1,
    ),
  );
  await f.bot.flush();
  assert.equal(f.telegram.calls.filter((call) => call.method === 'sendMessage').length, 0);
});

test('relay retries reuse the exact signed event; restart retains mappings, outbox and reply deduplication', async (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update());
  const parent = f.store.data.outbox[0].event.id;
  const event = f.reply(parent);
  await f.bot.receiveReply(event);
  f.net.publish = async () => {
    throw new Error('offline');
  };
  await f.bot.flush();
  assert.equal(f.store.data.outbox[0].event.id, parent);
  await f.bot.close();
  const reopened = new State(f.dir);
  const restarted = new TelegramBridge({
    store: reopened,
    net: f.net,
    telegram: f.telegram,
    publicGroup: f.publicGroup,
    telegramChat: '@public_test',
    log() {},
  });
  restarted.chat = chat;
  t.after(() => restarted.close());
  await restarted.receiveReply(event);
  assert.equal(reopened.data.outbox.length, 1);
  assert.equal(reopened.data.links[parent].messageId, 42);
  assert.equal(reopened.data.offset, 11);
  reopened.data.outbox[0].retryAt = 0;
  f.net.publish = async (event) => f.published.push(event);
  await restarted.flush();
  assert.equal(f.published[0].id, parent);
});

test('Telegram 429 respects retry_after and a private transition prevents sends', async (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update());
  await f.bot.receiveReply(f.reply(f.store.data.outbox[0].event.id));
  f.telegram.fail = new TelegramError(429, 120);
  await f.bot.flush();
  const item = f.store.data.outbox[0];
  assert.ok(item.retryAt >= now() + 119);
  assert.equal(item.next, 0);
  item.retryAt = 0;
  f.telegram.chat = { ...chat, username: undefined };
  f.telegram.calls = [];
  await f.bot.flush();
  assert.equal(f.telegram.calls.filter((call) => call.method === 'sendMessage').length, 0);
});

test('long replies split without truncation or HTML/surrogate injection', () => {
  const content = '👋 <b>&'.repeat(1500);
  const parts = replyParts('Ben', content, 'https://anagram.chat/test');
  assert.ok(parts.length > 1);
  const encoded = parts
    .map((part) => part.split('replied:\n&quot;')[1].split('"\nJoin the group')[0])
    .join('');
  assert.equal(encoded, escapeHTML(content));
  for (const part of parts) {
    const plain = part
      .replace(/<[^>]+>/g, '')
      .replaceAll('&quot;', '"')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
    assert.ok(plain.length <= 4096);
    assert.ok(plain.isWellFormed());
  }
});

test('Telegram wrapper sends POST JSON and sanitizes token-bearing network errors', async () => {
  let request;
  const api = new Telegram('123:secret', {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    },
  });
  await api.call('getUpdates', { offset: 10 });
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { offset: 10 });
  api.fetch = async () => {
    throw new Error('https://api.telegram.org/bot123:secret/getUpdates');
  };
  await assert.rejects(api.call('getUpdates'), (error) => !error.message.includes('secret'));
});

test('startup rejects private groups, webhooks and mismatched persisted bridge binding', async (t) => {
  const f = fixture(t);
  f.telegram.chat = { ...chat, type: 'group', username: undefined };
  await assert.rejects(f.bot.start(), /public supergroup/);
  f.telegram.chat = chat;
  f.store.data.binding = 'another-bridge';
  await assert.rejects(f.bot.start(), /Saved bridge differs/);
  f.telegram.call = async (method) =>
    method === 'getMe' ? { id: 123 } : { url: 'https://example.org/webhook' };
  await assert.rejects(f.bot.start(), /Remove the Telegram webhook/);
});

test('real relay streams replies and polling publishes only configured public messages', async (t) => {
  const f = fixture(t);
  const local = await relay();
  const net = new Network([local.url]);
  t.after(() => local.close());
  f.bot.net = net;
  f.telegram.updates = [f.update()];
  await f.bot.start();
  await f.bot.poll();
  await f.bot.submit('flush', () => f.bot.flush());
  const parent = [...local.events.values()].find((event) => event.kind === 9);
  assert.ok(parent);
  const reply = f.reply(parent.id);
  local.emit(reply);
  await until(() => f.store.data.outbox.some((item) => item.direction === 'telegram'));
  await f.bot.submit('flush', () => f.bot.flush());
  assert.equal(f.telegram.calls.filter((call) => call.method === 'sendMessage').length, 1);
  assert.deepEqual(
    f.telegram.calls.find((call) => call.method === 'getUpdates').body.allowed_updates,
    ['message'],
  );
  for (const subs of local.subscriptions.values())
    for (const filters of subs.values())
      assert.ok(filters.every((filter) => !filter.kinds.includes(1059)));
});

test('identical Telegram messages in the same second retain distinct event IDs and reply targets', (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update());
  f.bot.receiveTelegram(f.update({ message_id: 43 }, 11));
  const [first, second] = f.store.data.outbox;
  assert.notEqual(first.event.id, second.event.id);
  assert.equal(f.store.data.links[first.event.id].messageId, 42);
  assert.equal(f.store.data.links[second.event.id].messageId, 43);
});

test('a partially sent long reply resumes at the first unacknowledged part', async (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update());
  const parent = f.store.data.outbox[0].event.id;
  await f.bot.receiveReply(
    sign(
      f.author,
      9,
      [
        ['a', f.bot.address],
        ['q', parent],
      ],
      'x'.repeat(8000),
    ),
  );
  const original = f.telegram.call.bind(f.telegram);
  let sends = 0;
  f.telegram.call = async (method, body) => {
    if (method === 'sendMessage' && ++sends === 2) throw new TelegramError(429, 1);
    return original(method, body);
  };
  await f.bot.flush();
  const pending = f.store.data.outbox[0];
  assert.equal(pending.next, 1);
  assert.equal(JSON.parse(readFileSync(f.store.file)).outbox[0].next, 1);
  pending.retryAt = 0;
  f.telegram.call = original;
  await f.bot.flush();
  assert.equal(f.store.data.outbox.length, 0);
  assert.deepEqual(
    f.telegram.calls.filter((call) => call.method === 'sendMessage').map((call) => call.body.text),
    pending.parts,
  );
});

test('private group identifiers and conflicting saved Nostr identities fail closed', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      new TelegramBridge({
        store: f.store,
        net: f.net,
        telegram: f.telegram,
        publicGroup: nip19.npubEncode(getPublicKey(f.owner)),
        telegramChat: '@public_test',
      }),
    /PUBLIC_GROUP/,
  );
  f.store.close();
  assert.throws(
    () => new State(f.dir, { nsec: nip19.nsecEncode(generateSecretKey()) }),
    /NSEC differs/,
  );
  const restored = new State(f.dir);
  assert.equal(getPublicKey(restored.key), f.bot.pubkey);
  restored.close();
});

test('Telegram deletions remove only mapped imports, cancel pending replies, and persist signed NIP-09 requests', async (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update());
  const original = f.store.data.outbox[0].event;
  await f.bot.receiveReply(f.reply(original.id));
  f.bot.receiveTelegram(f.update({ message_id: 43 }, 11));
  const other = f.store.data.outbox.find(
    (item) => item.event?.kind === 9 && item.event.id !== original.id,
  ).event;
  f.bot.receiveTelegramDeletes(chat.id - 1, [42]);
  assert.equal(f.store.data.outbox.length, 3);
  f.bot.receiveTelegramDeletes(chat.id, [42, 999, -1]);
  assert.equal(f.store.data.links[original.id], undefined);
  assert.equal(f.store.data.links[other.id].messageId, 43);
  assert.equal(f.store.data.outbox.length, 2);
  const deletion = f.store.data.outbox.find((item) => item.event.kind === 5).event;
  assert.equal(deletion.pubkey, original.pubkey);
  assert.deepEqual(deletion.tags, [
    ['h', f.bot.address],
    ['k', '9'],
    ['e', original.id],
  ]);
  assert.equal(verifyEvent(deletion), true);
  const disk = JSON.parse(readFileSync(f.store.file));
  assert.equal(disk.links[original.id], undefined);
  assert.equal(disk.outbox[1].event.id, deletion.id);
  f.bot.receiveTelegramDeletes(chat.id, [42]);
  await f.bot.receiveReply(f.reply(original.id));
  assert.equal(f.store.data.outbox.length, 2);
  await f.bot.flush();
  assert.deepEqual(
    f.published.map((event) => event.id),
    [other.id, deletion.id],
  );
  assert.equal(f.telegram.calls.filter((call) => call.method === 'sendMessage').length, 0);
});

test('deletion arriving before the Bot API message prevents a later import, including after restart', async (t) => {
  const f = fixture(t);
  f.bot.receiveTelegramDeletes(chat.id, [42]);
  f.store.close();
  const store = new State(f.dir);
  f.bot.store = store;
  f.bot.state = store.data;
  f.bot.receiveTelegram(f.update());
  assert.equal(store.data.outbox.length, 0);
  assert.deepEqual(store.data.links, {});
  assert.equal(store.data.offset, 11);
});

test('deletion retries survive restart, lost relay acknowledgements, expiry and revoked trust', async (t) => {
  const f = fixture(t);
  f.bot.receiveTelegram(f.update());
  const original = f.store.data.outbox[0].event;
  f.net.publish = async (event) => {
    f.published.push(event);
    throw new Error('lost ACK');
  };
  await f.bot.flush();
  f.bot.receiveTelegramDeletes(chat.id, [42]);
  const deletion = f.store.data.outbox[0].event;
  await f.bot.flush();
  f.store.close();
  const store = new State(f.dir);
  f.bot.store = store;
  f.bot.state = store.data;
  assert.equal(store.data.outbox[0].event.id, deletion.id);
  store.data.outbox[0].at = now() - 2 * 86400;
  store.data.outbox[0].retryAt = 0;
  f.bot.acceptRoom(f.room([['blocked', f.bot.pubkey]], now() + 1));
  f.net.publish = async (event) => f.published.push(event);
  await f.bot.flush();
  assert.deepEqual(
    f.published.map((event) => event.id),
    [original.id, deletion.id, deletion.id],
  );
  assert.equal(store.data.outbox.length, 0);
});

test('bulk deletion requests are bounded to 100 event references each', async (t) => {
  const f = fixture(t);
  const ids = Array.from({ length: 205 }, (_, i) => i + 1);
  for (const id of ids) f.bot.receiveTelegram(f.update({ message_id: id }, id));
  f.bot.receiveTelegramDeletes(chat.id, ids);
  assert.equal(f.store.data.outbox.length, 3);
  assert.deepEqual(
    f.store.data.outbox.map((item) => item.event.tags.filter((tag) => tag[0] === 'e').length),
    [100, 100, 5],
  );
  assert.deepEqual(f.store.data.links, {});
});
