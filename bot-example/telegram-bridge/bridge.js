import { getPublicKey, nip19 } from 'nostr-tools';
import { newer, now, sign, single, valid } from './runtime.js';
import { parseRoom, roomLink } from './public-groups.js';
import { replyParts, telegramName, telegramText } from './telegram.js';

const DAY = 86400;
export class TelegramBridge {
  constructor({ store, net, telegram, publicGroup, telegramChat, log = console.log }) {
    this.target = roomLink(publicGroup ?? '');
    if (!this.target)
      throw new Error('PUBLIC_GROUP must be an Anagram public group naddr or link.');
    if (!/^@\w+$/.test(telegramChat ?? '') && !/^-100\d+$/.test(telegramChat ?? ''))
      throw new Error('TELEGRAM_CHAT must be a public @username or supergroup ID.');
    this.store = store;
    this.state = store.data;
    this.key = store.key;
    this.pubkey = getPublicKey(this.key);
    this.net = net;
    this.telegram = telegram;
    this.telegramChat = telegramChat;
    this.log = log;
    this.address = `34550:${this.target.owner}:${this.target.slug}`;
    this.work = Promise.resolve();
    this.pending = new Set();
    this.stopped = false;
    if (this.state.room && parseRoom(this.state.room)?.address !== this.address)
      throw new Error(
        'Saved room differs from PUBLIC_GROUP. Use a separate DATA_DIR for each bridge.',
      );
  }
  save() {
    this.store.save();
  }
  get room() {
    return this.state.room && parseRoom(this.state.room);
  }
  get active() {
    const room = this.room;
    return (
      !!room &&
      (room.event.pubkey === this.pubkey || room.trusted.includes(this.pubkey)) &&
      !room.blocked.includes(this.pubkey)
    );
  }
  get link() {
    return `https://anagram.chat/join/chat.html#/public/${nip19.naddrEncode({
      kind: 34550,
      pubkey: this.target.owner,
      identifier: this.target.slug,
      relays: this.room?.relays ?? this.target.relays,
    })}`;
  }
  // All state mutations and sends share one queue, including polling and retries.
  submit(id, action) {
    if (this.stopped || this.pending.has(id) || this.pending.size >= 2000) return this.work;
    this.pending.add(id);
    const task = this.work.then(() => {
      if (!this.stopped) return action();
    });
    this.work = task
      .catch(() => {
        this.stopped = true;
      })
      .finally(() => this.pending.delete(id));
    return task;
  }
  acceptRoom(event) {
    const room = parseRoom(event);
    if (!room || room.address !== this.address || !newer(event, this.state.room)) return;
    this.state.room = event;
    this.save();
    if (this.started) this.watchRoom();
  }
  watchRoom() {
    this.stopMetadata?.();
    this.stopMessages?.();
    const relays = this.room?.relays ?? this.target.relays;
    this.stopMetadata = this.net.watch(
      relays,
      () => ({
        kinds: [34550],
        authors: [this.target.owner],
        '#d': [this.target.slug],
        limit: 10,
      }),
      (event) => {
        void this.submit(`room:${event.id}`, () => this.acceptRoom(event)).catch(() => {});
      },
      this.key,
    );
    this.stopMessages = this.net.watch(
      relays,
      () => ({
        kinds: [9],
        '#a': [this.address],
        since: Math.max(this.state.startedAt, now() - DAY),
        limit: 1000,
      }),
      (event) => {
        void this.submit(event.id, () => this.receiveReply(event)).catch(() => {});
      },
      this.key,
    );
  }
  async start() {
    const me = await this.telegram.call('getMe');
    const webhook = await this.telegram.call('getWebhookInfo');
    if (webhook.url) throw new Error('Remove the Telegram webhook before using this polling bot.');
    this.chat = await this.telegram.call('getChat', { chat_id: this.telegramChat });
    if (this.chat.type !== 'supergroup' || !this.chat.username || this.chat.has_protected_content)
      throw new Error('TELEGRAM_CHAT must be a public supergroup without protected content.');
    const member = await this.telegram.call('getChatMember', {
      chat_id: this.chat.id,
      user_id: me.id,
    });
    if (
      !['creator', 'administrator', 'member', 'restricted'].includes(member.status) ||
      (member.status === 'restricted' && (!member.is_member || !member.can_send_messages))
    )
      throw new Error('Add the Telegram bot to the group and allow it to send messages.');
    if (!me.can_read_all_group_messages && !['creator', 'administrator'].includes(member.status))
      throw new Error(
        'Disable privacy mode in BotFather and re-add the bot, or make it an administrator.',
      );
    const binding = `${me.id}:${this.chat.id}:${this.address}`;
    if (this.state.binding && this.state.binding !== binding)
      throw new Error('Saved bridge differs from configuration. Use a separate DATA_DIR.');
    this.state.binding = binding;
    this.telegramId = me.id;
    this.save();
    for (const event of await this.net.query(this.target.relays, {
      kinds: [34550],
      authors: [this.target.owner],
      '#d': [this.target.slug],
      limit: 10,
    }))
      this.acceptRoom(event);
    this.started = true;
    this.watchRoom();
    this.log(`Telegram Bridge: ${nip19.npubEncode(this.pubkey)}`);
    if (!this.active)
      this.log(
        'Waiting for the Anagram owner to add this bot under Public group settings → Trusted.',
      );
    await this.net.publish(
      sign(
        this.key,
        0,
        [],
        JSON.stringify({
          name: 'Telegram Bridge',
          display_name: 'Telegram Bridge',
          bot: true,
          about:
            'Bridges a configured Telegram public group. Reply to a bridged message to reply on Telegram. Public groups only.',
        }),
      ),
      this.room?.relays ?? this.target.relays,
      this.key,
    );
  }
  receiveTelegram(update) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < (this.state.offset ?? 0))
      return;
    const message = update.message;
    if (
      message &&
      this.active &&
      message.chat?.id === this.chat.id &&
      message.chat.type === 'supergroup' &&
      message.chat.username &&
      !message.has_protected_content &&
      !message.is_from_offline &&
      message.from?.id !== this.telegramId &&
      message.date >= this.state.startedAt &&
      Number.isSafeInteger(message.message_id) &&
      message.message_id > 0
    ) {
      const text = telegramText(message);
      if (text) {
        if (this.state.outbox.length >= 1000)
          throw new Error('Outbox full; restore delivery before restarting.');
        const event = sign(
          this.key,
          9,
          [
            ['a', this.address],
            // Identical text from the same sender in one second must remain distinct.
            ['telegram', String(this.chat.id), String(message.message_id)],
          ],
          `${telegramName(message)} said:\n"${text}"`,
        );
        this.state.links[event.id] = {
          messageId: message.message_id,
          threadId: message.message_thread_id,
          at: now(),
        };
        this.state.outbox.push({ direction: 'nostr', event, at: now() });
      }
    }
    // The update is acknowledged only after the exact signed event and mapping are durable.
    this.state.offset = update.update_id + 1;
    this.save();
  }
  async receiveReply(event) {
    if (
      !this.active ||
      event.kind !== 9 ||
      !valid(event) ||
      single(event, 'a') !== this.address ||
      event.pubkey === this.pubkey ||
      this.room.blocked.includes(event.pubkey) ||
      !event.content.trim() ||
      event.content.length > 64000 ||
      event.created_at < Math.max(this.state.startedAt, now() - DAY) ||
      this.state.seen[event.id] ||
      event.tags.some((tag) => tag[0] === 'e' && tag[3] === 'edit')
    )
      return;
    const refs = event.tags.filter((tag) => tag[0] === 'q');
    if (refs.length !== 1 || (refs[0][3] && refs[0][3] !== this.pubkey)) return;
    const parent = this.state.links[refs[0][1]];
    if (!parent) return;
    if (this.state.outbox.length >= 1000)
      throw new Error('Outbox full; restore delivery before restarting.');
    let profile;
    try {
      for (const candidate of await this.net.query(this.room.relays, {
        kinds: [0],
        authors: [event.pubkey],
        limit: 5,
      }))
        if (
          candidate.kind === 0 &&
          candidate.pubkey === event.pubkey &&
          valid(candidate) &&
          newer(candidate, profile)
        )
          profile = candidate;
    } catch {
      /* A pubkey still identifies the author when profile lookup fails. */
    }
    let name = nip19.npubEncode(event.pubkey);
    try {
      const metadata = JSON.parse(profile.content);
      name =
        [metadata.display_name, metadata.name]
          .find((value) => typeof value === 'string' && value.trim())
          ?.trim() || name;
    } catch {
      /* Missing or malformed metadata uses npub. */
    }
    name = name.replace(/[\r\n]/g, ' ');
    this.state.seen[event.id] = now();
    this.state.outbox.push({
      direction: 'telegram',
      author: event.pubkey,
      at: now(),
      next: 0,
      parts: replyParts(name, event.content, this.link),
      parent: parent.messageId,
      threadId: parent.threadId,
    });
    this.save();
  }
  async flush() {
    for (const item of this.state.outbox.slice(0, 20)) {
      if (this.stopped) return;
      if (
        !this.active ||
        (item.author && this.room.blocked.includes(item.author)) ||
        item.at < now() - DAY
      ) {
        this.state.outbox.splice(this.state.outbox.indexOf(item), 1);
        this.save();
        continue;
      }
      if (item.retryAt > now()) continue;
      try {
        if (item.direction === 'nostr') {
          await this.net.publish(item.event, this.room.relays, this.key);
        } else {
          // Recheck public visibility before sending; a once-public chat can become private.
          const chat = await this.telegram.call('getChat', { chat_id: this.chat.id });
          if (chat.type !== 'supergroup' || !chat.username || chat.has_protected_content)
            throw new Error('Telegram group is no longer public.');
          while (item.next < item.parts.length) {
            await this.telegram.call('sendMessage', {
              chat_id: this.chat.id,
              text: item.parts[item.next],
              parse_mode: 'HTML',
              reply_parameters: { message_id: item.parent, allow_sending_without_reply: false },
              ...(item.threadId ? { message_thread_id: item.threadId } : {}),
              link_preview_options: { is_disabled: true },
            });
            item.next++;
            this.save();
          }
        }
      } catch (error) {
        item.attempts = (item.attempts ?? 0) + 1;
        item.retryAt =
          now() + Math.max(error.retryAfter || 0, Math.min(300, 2 ** Math.min(item.attempts, 9)));
        this.save();
        this.log(`Delivery pending (${item.direction}); retry scheduled.`);
        continue;
      }
      this.state.outbox.splice(this.state.outbox.indexOf(item), 1);
      this.save();
    }
    // Keep old-message reply mappings for 30 days, with a hard cap for busy groups.
    const links = Object.entries(this.state.links).sort((a, b) => b[1].at - a[1].at);
    const pending = new Set(
      this.state.outbox.filter((item) => item.event).map((item) => item.event.id),
    );
    for (const [index, [id, entry]] of links.entries())
      if (!pending.has(id) && (index >= 50000 || entry.at < now() - 30 * DAY))
        delete this.state.links[id];
    for (const [id, at] of Object.entries(this.state.seen))
      if (at < now() - 2 * DAY) delete this.state.seen[id];
    this.save();
  }
  async poll() {
    const updates = await this.telegram.call('getUpdates', {
      offset: this.state.offset ?? 0,
      timeout: 30,
      limit: 100,
      allowed_updates: ['message'],
    });
    for (const update of updates)
      await this.submit(`telegram:${update.update_id}`, () => this.receiveTelegram(update));
  }
  async close() {
    this.stopped = true;
    this.telegram.close();
    this.net.close();
    await this.work;
    this.store.close();
  }
}
