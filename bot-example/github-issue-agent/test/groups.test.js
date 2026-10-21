import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPublicKey, nip19 } from 'nostr-tools';
import { unwrapEvent } from 'nostr-tools/nip59';
import {
  alice,
  at,
  bob,
  codeOf,
  last,
  mallory,
  OTHER,
  privateGroup,
  publicGroup,
  refOf,
  REPO,
  replyTag,
  sendDM,
  setup,
} from './helpers.js';

test('private group: addressing, requester-only confirmation and shared history', async (t) => {
  const { bot, github, ollama } = setup(t);
  const g = privateGroup(bot);
  // Not addressed: ignored without being marked handled.
  const chatter = await g.say(alice, `there is a bug in ${REPO} with logins`);
  assert.equal(bot.state.seen[chatter.id], undefined);
  assert.equal(g.replies().length, 0);
  // Not allowed sender: ignored even when mentioning the bot.
  await g.say(mallory, `${at(bot)} create an issue in ${REPO} about logins`);
  assert.equal(g.replies().length, 0);
  // A bare /help is meant for any bot, so it is ignored.
  await g.say(alice, '/help');
  assert.equal(g.replies().length, 0);

  const request = await g.say(
    alice,
    `${at(bot)} create an issue in ${REPO} about the mobile login bug`,
  );
  const draftMessage = g.replies().at(-1);
  assert.match(draftMessage.content, /^Draft AG-/);
  assert.deepEqual(
    draftMessage.tags.find((tag) => tag[0] === 'e'),
    ['e', request.id, '', 'reply'],
  );
  const code = codeOf(draftMessage);
  const ref = refOf(draftMessage);

  // Bob is allowed and in the group, but cannot confirm or edit Alice's draft.
  await g.say(bob, `/confirm ${code}`);
  assert.match(g.replies().at(-1).content, /Only the person who requested/);
  await g.say(bob, 'add more detail', [replyTag(draftMessage.id)]);
  assert.match(g.replies().at(-1).content, /Only the person who requested/);
  assert.equal(ollama.calls.length, 1);

  // Alice edits by replying to the draft, then confirms with a bare command.
  await g.say(alice, 'mention it happens on Android', [replyTag(draftMessage.id)]);
  const revised = g.replies().at(-1);
  assert.match(revised.content, /^Updated draft/);
  await g.say(alice, `/confirm ${codeOf(revised)}`);
  assert.equal(github.creates.length, 1);
  assert.match(g.replies().at(-1).content, new RegExp(`Published ${ref}`));

  // Any authorized participant can see the group's history and the mapping.
  await g.say(bob, `${at(bot)} /issues`);
  assert.match(g.replies().at(-1).content, new RegExp(`${ref} ${REPO}#1`));
  await g.say(bob, `/who ${ref}`);
  assert.ok(
    g
      .replies()
      .at(-1)
      .content.includes(nip19.npubEncode(getPublicKey(alice))),
  );
  // ...but not from somewhere else, not even the requester's own DM.
  await sendDM(bot, alice, `/who ${ref}`);
  assert.match(last(bot, alice).content, /No issue/);
  await sendDM(bot, alice, `/confirm ${codeOf(revised)}`);
  assert.match(last(bot, alice).content, /No draft with code/);
});

test('codes and references never cross between groups', async (t) => {
  const { bot, github } = setup(t);
  const a = privateGroup(bot);
  const b = privateGroup(bot);
  await a.say(alice, `${at(bot)} issue in ${REPO}: crash on start`);
  const code = codeOf(a.replies().at(-1));
  // A bare command with a foreign code is not addressed to the bot in group B.
  await b.say(alice, `/confirm ${code}`);
  assert.equal(b.replies().length, 0);
  await b.say(alice, `${at(bot)} /confirm ${code}`);
  assert.match(b.replies().at(-1).content, /No draft with code/);
  assert.equal(github.creates.length, 0);
});

test('private groups must be allowed', async (t) => {
  const { bot, logs } = setup(t);
  const g = privateGroup(bot, { allow: false });
  assert.equal(bot.state.groups[g.group], undefined);
  assert.ok(logs.some((line) => line.includes('not in ALLOWED_PRIVATE_GROUPS')));
});

test('public group: p-tag mention, q-tag reply edits, no repository list in public', async (t) => {
  const { bot, github } = setup(t);
  const room = publicGroup(bot);
  await room.say(alice, `${at(bot)} the login is broken`);
  const question = room.replies().at(-1);
  assert.match(question.content, /Which repository/);
  assert.ok(!question.content.includes('lnbits/'), 'repositories are not listed publicly');
  await room.say(alice, `the login is broken in ${REPO}`, [['p', bot.pubkey]]);
  const draftEvent = room.replies().at(-1);
  assert.match(draftEvent.content, /^Draft AG-/);
  await room.say(alice, 'add steps: open app, tap login', [['q', draftEvent.id, '', bot.pubkey]]);
  const revised = room.replies().at(-1);
  assert.match(revised.content, /^Updated draft/);
  await room.say(alice, `/confirm ${codeOf(revised)}`, [['p', bot.pubkey]]);
  assert.equal(github.creates.length, 1);
  await room.say(alice, `${at(bot)} /help`);
  assert.ok(!room.replies().at(-1).content.includes('Your repositories'));
  assert.match(room.replies().at(-1).content, /visible to the whole group/);
  await room.say(bob, `${at(bot)} /new lnbits/lnbits wallet bug`);
  assert.match(room.replies().at(-1).content, /not allowed to create issues in that repository\.$/);
  assert.ok(!room.replies().at(-1).content.includes('lnbits/lnbits'));
});

test('a DM reply references the request and the reply id is remembered for edits', async (t) => {
  const { bot } = setup(t);
  const request = await sendDM(bot, alice, `issue in ${REPO}: crash`);
  const reply = last(bot, alice);
  assert.deepEqual(reply.tags, [
    ['p', getPublicKey(alice)],
    ['e', request.id, '', 'reply'],
  ]);
  assert.equal(bot.sent.get(reply.id).kind, 'draft');
  // The bot also keeps a copy for itself.
  const own = bot.state.outbox.map((item) => {
    try {
      return unwrapEvent(item.event, bot.key);
    } catch {
      return null;
    }
  });
  assert.ok(own.some((m) => m?.id === reply.id));
});

test('groups never show private repositories, their drafts or their issues', async (t) => {
  const { bot, github, ollama } = setup(t, { publicRepos: [REPO] });
  const g = privateGroup(bot);
  const room = publicGroup(bot);
  for (const chat of [g, room]) {
    const replies = () => chat.replies().map((e) => e.content);
    await chat.say(alice, `${at(bot)} create an issue in ${OTHER} about wallet sync`);
    assert.match(replies().at(-1), /not public, so I handle it only in a direct message/);
    await chat.say(alice, `${at(bot)} /help`);
    await chat.say(alice, `${at(bot)} the login is broken`);
    await chat.say(mallory, `${at(bot)} /help`);
    await chat.say(bob, `${at(bot)} /new ${OTHER} wallet bug`);
    assert.ok(
      replies().every((text) => !text.includes(OTHER) && !text.includes('Your repositories')),
    );
  }
  assert.equal(ollama.calls.length, 0);

  // A draft for a public repository whose repository turns private before publication:
  // the group only learns that the requester was told; the URL goes to the requester's DM.
  await g.say(alice, `${at(bot)} create an issue in ${REPO} about the login bug`);
  const code = codeOf(g.replies().at(-1));
  const ref = refOf(g.replies().at(-1));
  github.onCreate = (repo, issue) => {
    bot.publicRepos.delete(REPO);
    return github.create(repo, issue.title, issue.body);
  };
  await g.say(alice, `/confirm ${code}`);
  assert.equal(github.creates.length, 1);
  assert.equal(
    g.replies().at(-1).content,
    `${ref}: I sent the result to the requester by direct message.`,
  );
  assert.match(last(bot, alice).content, new RegExp(`Published ${ref} as ${REPO}#1: https://`));
  // Lists and lookups in the group now leave it out.
  await g.say(alice, `${at(bot)} /issues`);
  assert.match(g.replies().at(-1).content, /No issues have been created/);
  await g.say(bob, `/who ${ref}`);
  assert.match(g.replies().at(-1).content, /not public/);
  assert.ok(g.replies().every((e) => !e.content.includes('github.com')));
});

test('repository visibility comes from GitHub and anything unclear counts as private', async (t) => {
  const { bot, github, logs } = setup(t, { publicRepos: [] });
  github.privateRepos.add(OTHER);
  await bot.checkRepos(bot.log);
  assert.deepEqual([...bot.publicRepos], [REPO]);
  assert.ok(logs.some((line) => line === `${OTHER}: ok (not public: handled only in DMs)`));
  github.repository = async () => {
    throw new Error('offline');
  };
  await bot.checkRepos();
  assert.deepEqual([...bot.publicRepos], []);
});
