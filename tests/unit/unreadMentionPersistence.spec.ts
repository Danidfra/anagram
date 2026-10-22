import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { resetStores } from '#src/lib/state/store.svelte.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { useMessageStore } from '#src/stores/messageStore.svelte.ts';

const chatStore = vi.hoisted(() => ({
  selectedChatId: null as string | null,
  visibleChatId: null as string | null,
  setUnreadMentionAt: vi.fn(),
}));

vi.mock('#src/stores/chatStore.svelte.ts', () => ({
  useChatStore: () => chatStore,
}));

const GROUP = 'c'.repeat(64);
const OWN = 'b'.repeat(64);
const MEMBER = 'a'.repeat(64);
const READ_AT = '2026-10-01T00:00:00.000Z';
const FIRST = '2026-10-01T00:00:10.000Z';
const SECOND = '2026-10-01T00:00:20.000Z';

beforeEach(async () => {
  vi.stubGlobal('window', {
    indexedDB: new IDBFactory(),
    localStorage: { getItem: (key: string) => (key === 'npub' ? OWN : null) },
  });
  await chatDataService.createChat({
    public_key: GROUP,
    name: 'Group',
    type: 'group',
    meta: { last_seen_received_activity_at: READ_AT },
  });
});

afterEach(async () => {
  await chatDataService.clearAllData();
  resetStores();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function incoming(at: string, eventId: string, mentionsMe: boolean) {
  return {
    chat_public_key: GROUP,
    author_public_key: MEMBER,
    message: mentionsMe ? 'hi @me' : 'hello',
    created_at: at,
    event_id: eventId,
    meta: mentionsMe ? { mentions_me: true } : {},
    chat_activity: { incomingAt: at, unreadCount: 1, ...(mentionsMe ? { mentionAt: at } : {}) },
  };
}

it('persists the latest unread mention with the message and ignores already-read history', async () => {
  await chatDataService.createMessage(incoming('2026-09-30T00:00:00.000Z', 'd'.repeat(64), true));
  expect((await chatDataService.getChatByPublicKey(GROUP))?.meta).not.toHaveProperty(
    'unread_mention_at',
  );

  await chatDataService.createMessage(incoming(SECOND, 'e'.repeat(64), true));
  await chatDataService.createMessage(incoming(FIRST, 'f'.repeat(64), true));
  expect((await chatDataService.getChatByPublicKey(GROUP))?.meta.unread_mention_at).toBe(SECOND);
});

it('recomputes the unread mention after the latest mention is deleted or edited away', async () => {
  const first = await chatDataService.createMessage(incoming(FIRST, 'e'.repeat(64), true));
  const second = await chatDataService.createMessage(incoming(SECOND, 'f'.repeat(64), true));
  const store = useMessageStore();

  await chatDataService.updateMessageMeta(second!.id, {
    mentions_me: true,
    deleted: { deletedAt: SECOND },
  });
  await store.syncChatUnreadMention(GROUP);
  expect((await chatDataService.getChatByPublicKey(GROUP))?.meta.unread_mention_at).toBe(FIRST);
  expect(chatStore.setUnreadMentionAt).toHaveBeenLastCalledWith(GROUP, FIRST);

  await chatDataService.updateMessageMeta(first!.id, {});
  await store.syncChatUnreadMention(GROUP);
  expect((await chatDataService.getChatByPublicKey(GROUP))?.meta).not.toHaveProperty(
    'unread_mention_at',
  );
  expect(chatStore.setUnreadMentionAt).toHaveBeenLastCalledWith(GROUP, '');

  // An edit that adds a mention to a still-unread message raises it again.
  await chatDataService.updateMessageMeta(first!.id, { mentions_me: true });
  await store.syncChatUnreadMention(GROUP);
  expect((await chatDataService.getChatByPublicKey(GROUP))?.meta.unread_mention_at).toBe(FIRST);
});
