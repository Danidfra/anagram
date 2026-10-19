import {
  emitForegroundMessageActivity,
  FOREGROUND_MESSAGE_ACTIVITY_EVENT,
  readForegroundMessageActivityDetail,
} from '#src/services/foregroundMessageActivityService.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

class TestCustomEvent<T = unknown> extends Event {
  readonly detail: T;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type);
    this.detail = init?.detail as T;
  }
}

describe('foregroundMessageActivityService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('emits normalized foreground message activity details', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('CustomEvent', TestCustomEvent);
    vi.stubGlobal('window', { dispatchEvent });

    emitForegroundMessageActivity({
      chatPubkey: 'A'.repeat(64),
      iconUrl: '  https://example.test/alice.png  ',
      messageText: '  Hello   there  ',
      title: '  Alice   Chat  ',
      showBanner: true,
    });

    const event = dispatchEvent.mock.calls[0]?.[0] as Event;
    expect(event.type).toBe(FOREGROUND_MESSAGE_ACTIVITY_EVENT);
    expect(readForegroundMessageActivityDetail(event)).toEqual({
      chatPubkey: 'a'.repeat(64),
      iconUrl: 'https://example.test/alice.png',
      messageText: 'Hello there',
      title: 'Alice Chat',
      showBanner: true,
    });
  });

  it('ignores invalid foreground message activity details', () => {
    vi.stubGlobal('CustomEvent', TestCustomEvent);

    const event = new CustomEvent(FOREGROUND_MESSAGE_ACTIVITY_EVENT, {
      detail: {
        chatPubkey: 'not-a-pubkey',
        messageText: 'Hello',
        title: 'Alice',
        showBanner: true,
      },
    });

    expect(readForegroundMessageActivityDetail(event)).toBeNull();
  });
});

it('accepts public group activity without changing private conversation normalization', () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal('CustomEvent', TestCustomEvent);
  vi.stubGlobal('window', { dispatchEvent });
  try {
    const address = `34550:${'a'.repeat(64)}:Group_1`;
    for (const chatPubkey of [address, ` ${'A'.repeat(64)} `]) {
      emitForegroundMessageActivity({ chatPubkey, title: 'Group', messageText: 'hello', showBanner: true });
    }
    expect(readForegroundMessageActivityDetail(dispatchEvent.mock.calls[0][0])?.chatPubkey).toBe(address);
    expect(readForegroundMessageActivityDetail(dispatchEvent.mock.calls[1][0])?.chatPubkey).toBe('a'.repeat(64));
  } finally { vi.unstubAllGlobals(); }
});
