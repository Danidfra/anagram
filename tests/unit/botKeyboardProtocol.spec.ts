import { describe, expect, it } from 'vitest';
import {
  keyboardTag,
  keyboardFromTags,
  parseKeyboard,
  controlTag,
  parseControl,
  safeButtonUrl,
  type BotControl,
} from '#src/stores/nostr/botKeyboardProtocol.ts';
const keyboard = {
  inline_keyboard: [
    [
      { text: 'Yes', callback_data: 'yes' },
      { text: 'Website', url: 'https://example.org' },
    ],
  ],
};
describe('inline keyboard wire format', () => {
  it('round trips Telegram button rows in metadata, preserving Unicode callback bytes', () => {
    expect(keyboardFromTags([keyboardTag(keyboard)])).toEqual(keyboard);
    expect(
      parseKeyboard({ inline_keyboard: [[{ text: '👍', callback_data: '👍'.repeat(16) }]] }),
    ).not.toBeNull();
    expect(
      parseKeyboard({ inline_keyboard: [[{ text: '👍', callback_data: '👍'.repeat(17) }]] }),
    ).toBeNull();
    expect(keyboardFromTags([keyboardTag(keyboard), keyboardTag(keyboard)])).toBeNull();
    expect(keyboardFromTags([['anagram-inline-keyboard', '2', '{}']])).toBeNull();
  });
  it('rejects oversized, ambiguous and executable button definitions', () => {
    for (const button of [
      { text: 'x', callback_data: 'x', url: 'https://example.org' },
      { text: 'x', callback_data: '' },
      { text: 'x', callback_data: 'x', web_app: {} },
      { text: 'x', url: 'javascript:alert(1)' },
      { text: 'x', url: 'file:///etc/passwd' },
      { text: 'x', url: 'https://user:password@example.org/' },
      { text: 'x', url: 'https://example.org/\n' },
      { text: 'x'.repeat(129), callback_data: 'x' },
    ])
      expect(parseKeyboard({ inline_keyboard: [[button]] })).toBeNull();
    expect(
      parseKeyboard({ inline_keyboard: Array(9).fill(keyboard.inline_keyboard[0]) }),
    ).toBeNull();
    expect(
      parseKeyboard({ inline_keyboard: [[...Array(5).fill(keyboard.inline_keyboard[0][0])]] }),
    ).toBeNull();
    expect(safeButtonUrl('https://example.org')).toBe(true);
    expect(parseKeyboard({ inline_keyboard: [] })).toEqual({ inline_keyboard: [] });
  });
  it('binds versioned controls to typed conversations and requires private membership proof', () => {
    const bot = 'b'.repeat(64);
    const request: BotControl = {
      op: 'request',
      id: 'a'.repeat(32),
      expires: 1000,
      data: 'yes',
      target: { type: 'dm', bot, chat: bot, root: 'c'.repeat(64), version: 'd'.repeat(64) },
    };
    expect(parseControl([controlTag(request)])).toEqual(request);
    expect(() =>
      controlTag({ ...request, target: { ...request.target, chat: 'e'.repeat(64) } }),
    ).toThrow();
    expect(() =>
      controlTag({ ...request, target: { ...request.target, type: 'private' } }),
    ).toThrow();
    const privateRequest = {
      ...request,
      target: { ...request.target, type: 'private' as const },
      membership: { epoch: 1, invited_at: 100, invitation_proof: 'f'.repeat(128) },
    };
    expect(parseControl([controlTag(privateRequest)])).toEqual(privateRequest);
    expect(parseControl([controlTag(request), controlTag(request)])).toBeNull();
  });
});
