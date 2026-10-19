import { encodeRoomLink, roomAddress } from '#src/stores/nostr/publicGroups.ts';

export function notificationConversationId(value: string): string | null {
  value = value.trim();
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  try {
    return roomAddress(value).address;
  } catch {
    return null;
  }
}
export function notificationConversationPath(value: string): string {
  const id = notificationConversationId(value);
  if (!id) return '/chats';
  return id.startsWith('34550:') ? `/public/${encodeRoomLink(roomAddress(id))}` : `/chats/${id}`;
}
