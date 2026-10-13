export class TelegramError extends Error {
  constructor(code, retryAfter = 0) {
    // Never include a request URL: it contains the bot token.
    super(`Telegram API error ${code}`);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class Telegram {
  constructor(token, { fetchImpl = fetch } = {}) {
    if (!/^\d+:[\w-]+$/.test(token ?? '')) throw new Error('Configure TELEGRAM_BOT_TOKEN.');
    this.token = token;
    this.fetch = fetchImpl;
    this.controller = new AbortController();
  }
  async call(method, body = {}) {
    let response;
    try {
      response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(45000)]),
      });
    } catch {
      throw new TelegramError('network');
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new TelegramError(response.status);
    }
    if (!response.ok || !data.ok)
      throw new TelegramError(data.error_code ?? response.status, data.parameters?.retry_after);
    return data.result;
  }
  close() {
    this.controller.abort();
  }
}

export const escapeHTML = (text) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function telegramName(message) {
  const sender = message.sender_chat ?? message.from ?? {};
  return (
    sender.title ||
    [sender.first_name, sender.last_name].filter(Boolean).join(' ') ||
    sender.username ||
    'Telegram user'
  )
    .replace(/[\r\n]/g, ' ')
    .slice(0, 200);
}

export function telegramText(message) {
  if (typeof message.text === 'string') return message.text;
  const type = [
    'photo',
    'video',
    'animation',
    'audio',
    'voice',
    'video_note',
    'document',
    'sticker',
    'poll',
    'location',
    'venue',
    'contact',
    'dice',
  ].find((name) => message[name]);
  if (!type) return null; // Membership/pinning and other service updates are not chat messages.
  const detail = message.poll?.question || message.sticker?.emoji || '';
  const link = `https://t.me/${message.chat.username}/${message.message_id}`;
  return [message.caption, `[${type.replaceAll('_', ' ')}${detail ? `: ${detail}` : ''}] ${link}`]
    .filter(Boolean)
    .join('\n');
}

// Split raw text before HTML escaping, without breaking surrogate pairs. Every part
// remains a reply to the original Telegram message and includes the invitation.
export function replyParts(name, content, link) {
  const prefix = `${name.slice(0, 200)} replied:\n"`;
  const suffix = `"\nJoin the group at <a href="${escapeHTML(link)}">anagram.chat</a>`;
  const capacity = 4096 - prefix.length - '"\nJoin the group at anagram.chat'.length;
  const chunks = [];
  let chunk = '';
  for (const char of content) {
    if (chunk.length + char.length > capacity) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `${escapeHTML(prefix)}${escapeHTML(part)}${suffix}`);
}
