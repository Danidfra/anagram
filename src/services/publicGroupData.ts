import type { NostrEvent } from '#src/lib/nostr/client.ts';
import type { MessageRelayStatus } from '#src/types/chat.ts';
import { mergeMessageRelayStatuses } from '#src/utils/messageRelayStatus.ts';
import type { PublicRoom } from '#src/stores/nostr/publicGroups.ts';
export type PublicGroupMessage = NostrEvent & { relay_statuses?: MessageRelayStatus[] };
export interface SavedPublicRoom {
  address: string;
  room: PublicRoom;
  joined: boolean;
  successor?: string;
  updated: number;
}
export class PublicGroupData {
  private db: Promise<IDBDatabase>;
  constructor(account: string) {
    if (!/^[a-f0-9]{64}$/.test(account)) throw new Error('Public groups require an account.');
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(`anagram-public-groups-${account}`, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('rooms', { keyPath: 'address' });
        const messages = req.result.createObjectStore('messages', { keyPath: ['room', 'id'] });
        messages.createIndex('timeline', ['room', 'created_at', 'id']);
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }
  async close() {
    (await this.db).close();
  }
  private async transaction<T>(
    store: string,
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore, result: (value: T) => void) => void,
  ): Promise<T> {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Public group storage failed.'));
      run(tx.objectStore(store), (v) => {
        value = v;
      });
    });
  }
  list(): Promise<SavedPublicRoom[]> {
    return this.transaction('rooms', 'readonly', (s, done) => {
      const rows: SavedPublicRoom[] = [];
      const request = s.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length >= 200) {
          done(rows);
          return;
        }
        if (cursor.value.joined && !cursor.value.successor) rows.push(cursor.value);
        cursor.continue();
      };
    });
  }
  get(address: string): Promise<SavedPublicRoom | undefined> {
    return this.transaction('rooms', 'readonly', (s, done) => {
      const r = s.get(address);
      r.onsuccess = () => done(r.result);
    });
  }
  save(value: SavedPublicRoom): Promise<void> {
    return this.transaction('rooms', 'readwrite', (s) => {
      s.put(value);
    });
  }
  message(room: string, id: string): Promise<PublicGroupMessage | undefined> {
    return this.transaction('messages', 'readonly', (s, done) => {
      const request = s.get([room, id]);
      request.onsuccess = () => {
        const value = request.result;
        if (!value) return done(undefined);
        const { room: _, ...event } = value;
        done(event);
      };
    });
  }
  async put(room: string, event: PublicGroupMessage): Promise<PublicGroupMessage> {
    return (await this.putMany(room, [event]))[0];
  }
  async putMany(room: string, events: PublicGroupMessage[]): Promise<PublicGroupMessage[]> {
    const saved: PublicGroupMessage[] = [];
    // Merge receipt and ACK evidence atomically; replay must not erase delivery status.
    for (let offset = 0; offset < events.length; offset += 64) {
      const merged = new Map<string, PublicGroupMessage>();
      for (const event of events.slice(offset, offset + 64))
        merged.set(event.id!, {
          ...event,
          relay_statuses: mergeMessageRelayStatuses(
            merged.get(event.id!)?.relay_statuses ?? [],
            event.relay_statuses ?? [],
          ),
        });
      const batch = [...merged.values()];
      await this.transaction<void>('messages', 'readwrite', (s) => {
        let remaining = batch.length;
        for (const event of batch) {
          const request = s.get([room, event.id!]);
          request.onsuccess = () => {
            const relay_statuses = mergeMessageRelayStatuses(
              request.result?.relay_statuses ?? [],
              event.relay_statuses ?? [],
            ).slice(-32);
            const value = { ...event, ...(relay_statuses.length ? { relay_statuses } : {}) };
            saved.push(value);
            s.put({ ...value, room });
            if (--remaining === 0) prune();
          };
        }
        function prune() {
          let positioned = false;
          const request = s
            .index('timeline')
            .openCursor(
              IDBKeyRange.bound([room, 0, ''], [room, Number.MAX_SAFE_INTEGER, '\uffff']),
              'prev',
            );
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (!positioned) {
              positioned = true;
              cursor.advance(2000);
              return;
            }
            cursor.delete();
            cursor.continue();
          };
        }
      });
    }
    return saved;
  }
  page(
    room: string,
    before?: { created_at: number; id: string },
    limit = 50,
    direction: IDBCursorDirection = 'prev',
  ): Promise<PublicGroupMessage[]> {
    return this.transaction('messages', 'readonly', (s, done) => {
      const values: PublicGroupMessage[] = [];
      const r = s
        .index('timeline')
        .openCursor(
          IDBKeyRange.bound(
            direction === 'next' && before ? [room, before.created_at, before.id] : [room, 0, ''],
            direction === 'prev' && before
              ? [room, before.created_at, before.id]
              : [room, Number.MAX_SAFE_INTEGER, '\uffff'],
            direction === 'next' && Boolean(before),
            direction === 'prev' && Boolean(before),
          ),
          direction,
        );
      r.onsuccess = () => {
        const c = r.result;
        if (!c || values.length >= limit) {
          done(direction === 'prev' ? values.reverse() : values);
          return;
        }
        const { room: _, ...event } = c.value;
        values.push(event);
        c.continue();
      };
    });
  }
}
