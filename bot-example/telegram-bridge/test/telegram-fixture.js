export const chat = { id: -100123456, type: 'supergroup', username: 'public_test' };
export class FakeTelegram {
  constructor() {
    this.calls = [];
    this.updates = [];
    this.chat = { ...chat };
  }
  async call(method, body) {
    this.calls.push({ method, body });
    if (method === 'getMe') return { id: 123, can_read_all_group_messages: true };
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'getChat') return this.chat;
    if (method === 'getChatMember') return { status: 'member' };
    if (method === 'getUpdates') return this.updates;
    if (method === 'sendMessage') {
      if (this.fail) throw this.fail;
      return { message_id: 900 };
    }
    throw new Error(`Unexpected method ${method}`);
  }
  close() {}
}
