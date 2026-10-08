import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPublicKey, generateSecretKey, nip19 } from 'nostr-tools';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { DadBot, publishProfile } from '../bot.js';
import { Network, now, sign, State, wrap } from '../runtime.js';
import { relay, until } from './relay.js';

const parent = fileURLToPath(new URL('../data/', import.meta.url));
mkdirSync(parent, { recursive: true });

test(
  'over real relay sockets: profile, DM, automatic private/public joins, mentions, rotation and restart',
  { timeout: 60000 },
  async (t) => {
    const local = await relay();
    const dir = mkdtempSync(`${parent}relay-test-`);
    let bot, store;
    const start = async () => {
      store = new State(dir);
      bot = new DadBot({
        store,
        net: new Network([local.url]),
        jokes: [{ joke: 'Hello from Dad Jokes!' }],
        cooldown: 0,
        log() {},
        onFatal: (error) => {
          throw error;
        },
      });
      await bot.start();
    };
    t.after(async () => {
      await bot?.close();
      await local.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await start();
    await publishProfile(bot, { pictureURL: 'https://example.org/dad.png' });
    assert.ok([...local.events.values()].some((e) => e.kind === 10050 && e.pubkey === bot.pubkey));
    assert.ok([...local.events.values()].some((e) => e.kind === 0 && JSON.parse(e.content).bot));
    const user = generateSecretKey(),
      owner = generateSecretKey();
    const userPubkey = getPublicKey(user),
      group = getPublicKey(owner);
    const replies = (key) =>
      [...local.events.values()]
        .filter((e) => e.kind === 1059)
        .flatMap((event) => {
          try {
            const message = unwrapEvent(event, key);
            return message.pubkey === bot.pubkey ? [message] : [];
          } catch {
            return [];
          }
        });
    const dm = wrapEvent(
      { kind: 14, tags: [['p', bot.pubkey]], content: 'Tell me a joke', created_at: now() },
      user,
      bot.pubkey,
    );
    local.emit(dm);
    await until(() => replies(user).length === 1, 'DM joke');
    assert.equal(replies(user)[0].content, 'Hello from Dad Jokes!');

    let epochKey = generateSecretKey();
    const invite = (epoch) => {
      const ticket = sign(
        owner,
        1014,
        [
          ['p', bot.pubkey],
          ['epoch', String(epoch)],
        ],
        Buffer.from(epochKey).toString('hex'),
      );
      const { sig, ...unsigned } = ticket;
      local.emit(wrap(unsigned, owner, bot.pubkey, [['invitation_proof', sig]]));
    };
    const mention = (epoch) => {
      const proof = sign(
        owner,
        1014,
        [
          ['p', userPubkey],
          ['epoch', String(epoch)],
        ],
        Buffer.from(epochKey).toString('hex'),
      );
      local.emit(
        wrapEvent(
          {
            kind: 14,
            created_at: now(),
            content: `Hi nostr:${nip19.nprofileEncode({ pubkey: bot.pubkey })}`,
            tags: [
              ['p', getPublicKey(epochKey)],
              ['h', group],
              ['epoch', String(epoch)],
              ['invited_at', String(proof.created_at)],
              ['invitation_proof', proof.sig],
            ],
          },
          user,
          getPublicKey(epochKey),
        ),
      );
    };
    invite(0);
    await until(() => store.data.groups[group]?.epoch === 0, 'private invitation');
    mention(0);
    await until(() => replies(epochKey).length === 1, 'private joke');
    const old = epochKey;
    epochKey = generateSecretKey();
    invite(1);
    await until(() => store.data.groups[group]?.epoch === 1, 'epoch rotation');
    mention(1);
    await until(() => replies(epochKey).length === 1, 'new-epoch joke');
    assert.equal(replies(old).length, 1);

    const room = sign(owner, 34550, [
      ['d', 'public-room'],
      ['name', 'Public room'],
      ['anagram-room', '1'],
      ['relay', local.url],
      ['trusted', bot.pubkey],
    ]);
    const address = `34550:${group}:public-room`;
    local.emit(room);
    await until(() => store.data.rooms[address], 'automatic public join via trusted tag');
    const publicMessage = sign(
      user,
      9,
      [['a', address]],
      `Hello nostr:${nip19.npubEncode(bot.pubkey)}`,
    );
    local.emit(publicMessage);
    const publicReplies = () =>
      [...local.events.values()].filter((e) => e.kind === 9 && e.pubkey === bot.pubkey);
    await until(() => publicReplies().length === 1, 'public joke');
    assert.equal(publicReplies()[0].tags.find((t) => t[0] === 'q')[1], publicMessage.id);
    const npub = bot.pubkey;
    await bot.close();
    await start();
    assert.equal(bot.pubkey, npub);
    assert.equal(store.data.groups[group].epoch, 1);
    // Replayed events from all three histories must not create any new replies.
    await new Promise((r) => setTimeout(r, 2300));
    assert.equal(publicReplies().length, 1);
    assert.equal(replies(user).length, 1);
    assert.equal(replies(epochKey).length, 1);
    local.emit(
      sign(user, 9, [['a', address]], `After restart nostr:${nip19.npubEncode(bot.pubkey)}`),
    );
    await until(() => publicReplies().length === 2, 'post-restart public joke');
  },
);

test(
  'one relay ACK is sufficient and reconnect recovers randomized gift-wrap timestamps',
  { timeout: 30000 },
  async (t) => {
    const good = await relay(),
      bad = await relay();
    bad.reject = true;
    const network = new Network([bad.url, good.url]);
    t.after(async () => {
      network.close();
      await good.close();
      await bad.close();
    });
    const sender = generateSecretKey(),
      recipient = generateSecretKey(),
      pubkey = getPublicKey(recipient);
    const received = new Set();
    network.watch(
      [good.url],
      () => ({ kinds: [1059], '#p': [pubkey], since: now() - 3 * 86400 }),
      (e) => received.add(e.id),
      recipient,
    );
    const first = wrapEvent(
      { kind: 14, content: 'one', tags: [['p', pubkey]], created_at: now() },
      sender,
      pubkey,
    );
    await network.publish(first, [bad.url, good.url], sender);
    await until(() => received.has(first.id), 'first wrap');
    good.disconnect();
    const second = wrapEvent(
      { kind: 14, content: 'two', tags: [['p', pubkey]], created_at: now() },
      sender,
      pubkey,
    );
    // A newer inner message may have an older outer timestamp; force that situation.
    const olderOuter = sign(
      generateSecretKey(),
      1059,
      second.tags,
      second.content,
      first.created_at - 60,
    );
    // This tests transport replay only; keep a valid signed outer event with a lower timestamp.
    good.emit(olderOuter);
    await until(() => received.has(olderOuter.id), 'reconnected randomized-timestamp replay');
  },
);

test(
  'NIP-42 personal and epoch inboxes authenticate on separate connections',
  { timeout: 20000 },
  async (t) => {
    const local = await relay();
    local.requireAuth = true;
    const network = new Network([local.url]);
    t.after(async () => {
      network.close();
      await local.close();
    });
    const account = generateSecretKey(),
      epoch = generateSecretKey(),
      sender = generateSecretKey();
    const seen = new Set();
    for (const key of [account, epoch]) {
      const pubkey = getPublicKey(key);
      network.watch(
        [],
        () => ({ kinds: [1059], '#p': [pubkey] }),
        (e) => seen.add(e.id),
        key,
      );
      local.emit(
        wrapEvent(
          { kind: 14, tags: [['p', pubkey]], content: 'auth test', created_at: now() },
          sender,
          pubkey,
        ),
      );
    }
    await until(() => seen.size === 2, 'authenticated personal and epoch delivery');
  },
);
