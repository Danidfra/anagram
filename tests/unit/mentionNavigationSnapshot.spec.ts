import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { resetStores } from '#src/lib/state/store.svelte.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { useChatStore } from '#src/stores/chatStore.svelte.ts';

const GROUP = 'c'.repeat(64);
const OTHER_GROUP = 'd'.repeat(64);
const OWN = 'b'.repeat(64);
const MEMBER = 'a'.repeat(64);
const READ_AT = '2026-10-01T00:00:00.000Z';
const at = (second: number) => new Date(Date.parse(READ_AT) + second * 1000).toISOString();
let account: string | null = OWN;

async function seedGroup(publicKey: string, mentionSecond: number) {
  await chatDataService.createChat({
    public_key: publicKey,
    name: 'Group',
    type: 'group',
    meta: { last_seen_received_activity_at: READ_AT, inbox_state: 'accepted' },
  });
  await chatDataService.createMessage({
    chat_public_key: publicKey,
    author_public_key: MEMBER,
    message: 'hi @me',
    created_at: at(mentionSecond),
    event_id: publicKey.slice(0, 63) + String(mentionSecond % 10),
    meta: { mentions_me: true },
    chat_activity: { incomingAt: at(mentionSecond), unreadCount: 1, mentionAt: at(mentionSecond) },
  });
}

beforeEach(async () => {
  account = OWN;
  vi.stubGlobal('window', {
    indexedDB: new IDBFactory(),
    localStorage: { getItem: (key: string) => (key === 'npub' ? account : null) },
  });
  await seedGroup(GROUP, 5);
  await seedGroup(OTHER_GROUP, 6);
});

afterEach(async () => {
  await chatDataService.clearAllData();
  resetStores();
  vi.unstubAllGlobals();
});

it('captures the read boundary of the opened group before marking it read', async () => {
  const chats = useChatStore();
  await chats.reload();
  chats.selectChat(GROUP);

  await chats.markAsRead(GROUP);

  expect(chats.getUnreadMentionSnapshot(GROUP)).toBe(READ_AT);
  expect(chats.chats.find((chat) => chat.id === GROUP)?.unreadCount).toBe(0);
  // A second read after the mention is gone keeps the captured boundary.
  await chats.markAsRead(GROUP);
  expect(chats.getUnreadMentionSnapshot(GROUP)).toBe(READ_AT);

  chats.clearUnreadMentionSnapshot(GROUP);
  expect(chats.getUnreadMentionSnapshot(GROUP)).toBeNull();
});

it('ignores "mark as read" from the chat list and other accounts', async () => {
  const chats = useChatStore();
  await chats.reload();
  chats.selectChat(GROUP);

  await chats.markAsRead(OTHER_GROUP);
  expect(chats.getUnreadMentionSnapshot(OTHER_GROUP)).toBeNull();

  await chats.markAsRead(GROUP);
  account = 'e'.repeat(64);
  expect(chats.getUnreadMentionSnapshot(GROUP)).toBeNull();
});

it('captures a group read because it became visible', async () => {
  const chats = useChatStore();
  await chats.reload();
  chats.setVisibleChatId(OTHER_GROUP);

  await chats.markAsRead(OTHER_GROUP);

  expect(chats.getUnreadMentionSnapshot(OTHER_GROUP)).toBe(READ_AT);
});
