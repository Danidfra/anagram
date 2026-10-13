import { Api } from 'teleproto';
import { chat } from './telegram-fixture.js';

export function fakeMTProto() {
  const channelId = 1234567890n;
  const client = {
    channelId,
    entity: new Api.Channel({
      id: channelId,
      accessHash: 456n,
      title: 'Test',
      username: chat.username,
      megagroup: true,
    }),
    session: { save: () => 'private-session' },
    updates: {
      catch(handler) {
        client.errorHandler = handler;
      },
      watch(entity, handler, options) {
        client.watched = { entity, handler, options };
        return () => {
          client.unwatched = true;
        };
      },
    },
    async start(options) {
      this.auth = options;
    },
    async getMe() {
      return { id: 123n, bot: true };
    },
    async getEntity() {
      return this.entity;
    },
    async invoke(request) {
      this.request = request;
      return { messages: this.messages ?? [] };
    },
    onReconnect(handler) {
      this.reconnect = handler;
      return () => {
        this.off = true;
      };
    },
    async destroy() {
      this.destroyed = true;
    },
  };
  return client;
}
