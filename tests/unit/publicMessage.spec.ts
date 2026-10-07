import { expect, it } from 'vitest';
import { redactPublicLinks } from '#src/utils/publicMessage.ts';
it.each([
  ['visit https://example.org/page.', 'visit [link removed].'],
  ['WWW.example.org https://example.org/picture.png', '[link removed] [link removed]'],
  [
    '[site](https://example.org) and `http://example.org`',
    '[site]([link removed]) and `[link removed]`',
  ],
  ['normal text **bold** 😀', 'normal text **bold** 😀'],
])('redacts public URLs as inert text: %s', (text, expected) =>
  expect(redactPublicLinks(text)).toBe(expected),
);
