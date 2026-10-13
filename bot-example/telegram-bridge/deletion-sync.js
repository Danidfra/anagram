import { Api, Logger, TelegramClient, utils } from 'teleproto';
import { StringSession } from 'teleproto/sessions';

export function deletionConfig(env) {
  const id = env.TELEGRAM_API_ID?.trim();
  const hash = env.TELEGRAM_API_HASH?.trim();
  if (!id && !hash) return undefined;
  if (
    !/^\d+$/.test(id ?? '') ||
    Number(id) < 1 ||
    Number(id) > 2147483647 ||
    !/^[a-f\d]{32}$/i.test(hash ?? '')
  )
    throw new Error(
      'Configure both TELEGRAM_API_ID (number) and TELEGRAM_API_HASH (32 hex characters) to enable deletion sync.',
    );
  return { apiId: Number(id), apiHash: hash };
}

// MTProto is used only for deletions. The existing Bot API message/reply path stays separate.
export class DeletionSync {
  constructor({ bot, apiId, apiHash, token, client }) {
    this.bot = bot;
    this.token = token;
    this.client =
      client ??
      new TelegramClient(new StringSession(bot.state.mtprotoSession ?? ''), apiId, apiHash, {
        baseLogger: new Logger('none'),
        connectionRetries: 5,
        requestRetries: 3,
        floodSleepThreshold: 0,
        channelPollInterval: 5000,
      });
    // Library errors can include request credentials. Never forward their text to logs.
    this.client.onError = async () => this.warn();
    this.client.updates.catch(() => this.warn());
    this.closed = false;
  }
  warn() {
    if (!this.closed && (!this.lastWarning || Date.now() - this.lastWarning > 30000)) {
      this.lastWarning = Date.now();
      this.bot.log('Telegram deletion sync interrupted; check connectivity and bot permissions.');
    }
  }
  async start() {
    await this.client.start({ botAuthToken: this.token });
    const me = await this.client.getMe();
    if (!me.bot || String(me.id) !== String(this.bot.telegramId))
      throw new Error('Saved MTProto session differs from the configured Telegram bot.');
    const entity = await this.client.getEntity(`@${this.bot.chat.username}`);
    if (
      !(entity instanceof Api.Channel) ||
      !entity.megagroup ||
      entity.left ||
      entity.noforwards ||
      !entity.username ||
      utils.getPeerId(entity) !== String(this.bot.chat.id)
    )
      throw new Error('TELEGRAM_CHAT must match an accessible public MTProto supergroup.');
    this.channel = utils.getInputChannel(entity);
    if (this.closed || this.bot.stopped) return;
    await this.bot.submit('mtproto-session', () => {
      this.bot.state.mtprotoSession = this.client.session.save();
      this.bot.save();
    });
    if (this.closed || this.bot.stopped) return;
    this.unwatch = this.client.updates.watch(entity, (update) => this.receive(update), {
      events: 'deleteChannelMessages',
    });
    this.offReconnect = this.client.onReconnect(() => {
      void this.reconcile().catch(() => this.warn());
    });
    await this.reconcile();
    this.bot.log('Telegram deletion sync enabled; checked up to 50 recent bridged messages.');
  }
  receive(update) {
    if (
      this.closed ||
      !(update instanceof Api.UpdateDeleteChannelMessages) ||
      String(update.channelId) !== String(this.channel.channelId)
    )
      return;
    // Do not coalesce distinct updates: each can contain different deleted IDs.
    return this.bot.submit(Symbol('telegram-deletion'), () =>
      this.bot.receiveTelegramDeletes(this.bot.chat.id, update.messages),
    );
  }
  reconcile() {
    // A reconnect can overlap the initial check. Keep one bounded request in flight.
    if (!this.checking) {
      this.checking = this.checkRecent().finally(() => {
        this.checking = undefined;
      });
    }
    return this.checking;
  }
  async checkRecent() {
    if (this.closed || this.bot.stopped) return;
    const ids = [...new Set(Object.values(this.bot.state.links).map((link) => link.messageId))]
      .sort((a, b) => b - a)
      .slice(0, 50);
    if (!ids.length) return;
    // Verify membership and public visibility before interpreting MessageEmpty responses.
    const entity = await this.client.getEntity(this.channel);
    if (
      !(entity instanceof Api.Channel) ||
      entity.left ||
      !entity.megagroup ||
      !entity.username ||
      entity.noforwards ||
      String(entity.id) !== String(this.channel.channelId)
    )
      throw new Error('Telegram group is not accessible.');
    const result = await this.client.invoke(
      new Api.channels.GetMessages({
        channel: this.channel,
        id: ids.map((id) => new Api.InputMessageID({ id })),
      }),
    );
    if (!Array.isArray(result.messages)) throw new Error('Invalid Telegram message response.');
    // A missing result, partial response, or failed request is NOT evidence of deletion.
    const deleted = result.messages
      .filter(
        (message) =>
          message instanceof Api.MessageEmpty &&
          ids.includes(message.id) &&
          (!message.peerId ||
            (message.peerId instanceof Api.PeerChannel &&
              String(message.peerId.channelId) === String(this.channel.channelId))),
      )
      .map((message) => message.id);
    if (!this.closed)
      await this.bot.submit(Symbol('telegram-reconcile'), () =>
        this.bot.receiveTelegramDeletes(this.bot.chat.id, deleted),
      );
  }
  async close() {
    this.closed = true;
    this.unwatch?.();
    this.offReconnect?.();
    await this.client.destroy();
    await this.checking?.catch(() => {});
  }
}
