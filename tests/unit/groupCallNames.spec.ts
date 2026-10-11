import { afterEach, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it('retains CSS, names and enabled state across reloads, separately per account', async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  const account = 'a'.repeat(64),
    other = 'c'.repeat(64);
  let prefs = await import('#src/lib/state/groupCallNames.ts');
  expect(get(prefs.groupCallNames(account))).toEqual(prefs.defaultGroupCallName());
  const mine = { name: 'Host', cssEnabled: true, css: '.customname { color: red; }' };
  prefs.saveGroupCallName(account, mine);
  expect(get(prefs.groupCallNames(other))).toEqual(prefs.defaultGroupCallName());
  vi.resetModules();
  prefs = await import('#src/lib/state/groupCallNames.ts');
  expect(get(prefs.groupCallNames(account))).toEqual(mine);
  prefs.saveGroupCallName(account, { ...mine, cssEnabled: false });
  expect(get(prefs.groupCallNames(account)).css).toBe(mine.css);
});
it('handles unavailable storage and malformed saved settings without breaking calls', async () => {
  vi.stubGlobal('localStorage', {
    getItem: () => '{invalid',
    setItem: () => {
      throw new Error('full');
    },
  });
  const prefs = await import('#src/lib/state/groupCallNames.ts');
  const account = 'd'.repeat(64);
  expect(get(prefs.groupCallNames(account))).toEqual(prefs.defaultGroupCallName());
  const value = { ...prefs.defaultGroupCallName(), name: 'Session only' };
  prefs.saveGroupCallName(account, value);
  expect(get(prefs.groupCallNames(account))).toEqual(value);
});

it('migrates only own settings and discards remote aliases', async () => {
  const account = 'e'.repeat(64);
  const own = { name: 'My shared name', cssEnabled: true, css: '.customname {color:red}' };
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      key === `ui-group-call-names:${account}`
        ? JSON.stringify({ [account]: own, ['f'.repeat(64)]: { ...own, name: 'Remote alias' } })
        : null,
  });
  const prefs = await import('#src/lib/state/groupCallNames.ts');
  expect(get(prefs.groupCallNames(account))).toEqual(own);
});

it('updates a saved unmodified example to the bottom-left while preserving customized CSS', async () => {
  const { DEFAULT_CUSTOM_NAME_CSS, groupCallNames } =
    await import('#src/lib/state/groupCallNames.ts');
  const oldExample = DEFAULT_CUSTOM_NAME_CSS.replace('position: absolute', 'position: fixed')
    .replace('left: 16px', 'left: 200px')
    .replace('bottom: 16px', 'bottom: 200px');
  const custom = oldExample.replace('#ed24ff', '#ffffff');
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      JSON.stringify({
        name: 'Me',
        cssEnabled: true,
        css: key.endsWith('a'.repeat(64)) ? oldExample : custom,
      }),
  });
  expect(get(groupCallNames('a'.repeat(64))).css).toBe(DEFAULT_CUSTOM_NAME_CSS);
  expect(get(groupCallNames('b'.repeat(64))).css).toBe(custom);
});
