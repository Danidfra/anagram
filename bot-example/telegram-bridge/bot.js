import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Network, State } from './runtime.js';
import { Telegram, TelegramError } from './telegram.js';
import { TelegramBridge } from './bridge.js';

export async function main() {
  process.umask(0o077);
  const telegram = new Telegram(process.env.TELEGRAM_BOT_TOKEN);
  const store = new State(
    process.env.DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url)),
    { nsec: process.env.NSEC },
  );
  let bot, timer, closing, net;
  const shutdown = () => {
    if (!closing) {
      clearInterval(timer);
      closing = bot
        ? bot.close()
        : Promise.resolve().then(() => {
            telegram.close();
            net?.close();
            store.close();
          });
    }
    return closing;
  };
  try {
    net = new Network(
      (process.env.RELAYS || 'wss://relay.damus.io,wss://nos.lol')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    );
    bot = new TelegramBridge({
      store,
      net,
      telegram,
      publicGroup: process.env.PUBLIC_GROUP,
      telegramChat: process.env.TELEGRAM_CHAT,
    });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await bot.start();
    if (bot.stopped) return;
    timer = setInterval(() => {
      void bot
        .submit('flush', () => bot.flush())
        .catch(() => {
          console.error('Bridge stopped after an internal or storage error.');
          process.exitCode = 1;
          void shutdown();
        });
    }, 2000);
    while (!bot.stopped) {
      try {
        await bot.poll();
      } catch (error) {
        if (bot.stopped) break;
        if (!(error instanceof TelegramError) || [401, 409].includes(error.code)) throw error;
        console.error('Telegram polling failed; retrying. Check connectivity and bot permissions.');
        await delay(Math.max(1000, (error.retryAfter || 5) * 1000), undefined, {
          signal: telegram.controller.signal,
        }).catch(() => {});
      }
    }
    if (!closing) throw new Error('Bridge stopped after an internal or storage error.');
  } finally {
    await shutdown();
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    // All Telegram errors are sanitized in the API wrapper; unexpected errors may
    // contain secrets, so print only our explicit configuration errors.
    const safe =
      /^(Configure |PUBLIC_GROUP |TELEGRAM_CHAT |Saved |Remove the Telegram |Add the Telegram |Disable privacy |NSEC |Bridge stopped)/.test(
        error.message,
      );
    console.error(
      safe
        ? error.message
        : 'Cannot run Telegram Bridge. Check configuration, relay access, and data directory permissions.',
    );
    process.exitCode = 1;
  });
}
