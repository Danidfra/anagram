import type { NostrEvent } from '#src/lib/nostr/client.ts';
import {
  HEX,
  targetKey,
  type BotControl,
  type InlineKeyboard,
} from '#src/stores/nostr/botKeyboardProtocol.ts';

export interface BotInteraction {
  key: string;
  updated: number;
  request: BotControl;
  created: number;
  wrap?: NostrEvent;
  answer?: { eventId: string; text: string; keyboard: InlineKeyboard | null };
  previous?: BotInteraction['answer'];
}

// Small account-specific interaction cache. Never read the message archive.
async function database(owner: string): Promise<IDBDatabase> {
  if (!HEX.test(owner)) throw new Error('No active account');
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`anagram-bot-interactions-${owner}`, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore('interactions', { keyPath: 'key' });
      store.createIndex('request', 'request.id', { unique: true });
      store.createIndex('updated', 'updated');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function readBotInteraction(
  owner: string,
  key: string,
  byRequest = false,
): Promise<BotInteraction | undefined> {
  const db = await database(owner);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('interactions', 'readonly');
    const store = tx.objectStore('interactions');
    const req = (byRequest ? store.index('request') : store).get(key);
    tx.oncomplete = () => {
      db.close();
      resolve(req.result);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function saveBotInteraction(
  owner: string,
  value: BotInteraction,
  expectedId?: string,
): Promise<boolean> {
  const db = await database(owner);
  return new Promise((resolve, reject) => {
    let saved = false;
    const tx = db.transaction('interactions', 'readwrite');
    const store = tx.objectStore('interactions');
    const current = store.get(value.key);
    current.onsuccess = () => {
      if (
        value.key !== targetKey(value.request.target) ||
        (expectedId && current.result?.request.id !== expectedId) ||
        (expectedId && current.result?.answer && !value.answer)
      )
        return;
      store.put(value);
      saved = true;
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - 500;
        if (excess <= 0) return;
        const cursor = store.index('updated').openCursor();
        cursor.onsuccess = () => {
          if (cursor.result && excess-- > 0) {
            cursor.result.delete();
            cursor.result.continue();
          }
        };
      };
    };
    tx.oncomplete = () => {
      db.close();
      resolve(saved);
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
