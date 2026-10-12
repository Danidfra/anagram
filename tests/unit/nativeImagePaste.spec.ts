import { afterEach, expect, it, vi } from 'vitest';
import { nativeImagePaste } from '#src/lib/actions/nativeImagePaste.ts';

const core = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => core);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  core.isTauri.mockReturnValue(true);
});

function setup(userAgent = 'Linux') {
  vi.stubGlobal('navigator', { userAgent });
  const listeners = new Map<string, (event?: unknown) => unknown>();
  const node = {
    isConnected: true,
    ownerDocument: { activeElement: null as unknown },
    addEventListener: (name: string, listener: (event: unknown) => unknown) =>
      listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  };
  node.ownerDocument.activeElement = node;
  let enabled = true,
    context = 'alice:chat';
  const onfile = vi.fn();
  const action = nativeImagePaste(node as unknown as HTMLTextAreaElement, {
    enabled: () => enabled,
    context: () => context,
    onfile,
  });
  const event = (text = '', files: unknown[] = [], isTrusted = true) => ({
    isTrusted,
    clipboardData: { files, getData: () => text },
  });
  return {
    listeners,
    node,
    onfile,
    action,
    event,
    paste: (e = event()) => listeners.get('paste')?.(e),
    disable: () => {
      enabled = false;
    },
    changeContext: () => {
      context = 'bob:other';
    },
  };
}
it.each(['Windows', 'Macintosh', 'Linux Android'])(
  'does not attach a fallback on %s',
  (platform) => {
    expect(setup(platform).listeners.size).toBe(0);
  },
);
it('does not attach a fallback in a browser', () => {
  core.isTauri.mockReturnValue(false);
  expect(setup().listeners.size).toBe(0);
});
it('leaves text, files, untrusted events and disabled attachments alone', async () => {
  const f = setup();
  await f.paste(f.event('caption'));
  await f.paste(f.event('', [{}]));
  await f.paste(f.event('', [], false));
  f.disable();
  await f.paste();
  expect(core.invoke).not.toHaveBeenCalled();
});
it('hands the native PNG to the existing upload callback', async () => {
  const f = setup();
  core.invoke.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  await f.paste();
  expect(core.invoke).toHaveBeenCalledExactlyOnceWith('read_clipboard_image');
  const file = f.onfile.mock.calls[0][0] as File;
  expect([file.name, file.type, file.size]).toEqual(['image.png', 'image/png', 3]);
});
it.each(['blur', 'context', 'disabled', 'destroy', 'disconnected', 'new paste'])(
  'ignores a delayed result after %s',
  async (reason) => {
    const f = setup();
    let resolve!: (value: ArrayBuffer) => void;
    core.invoke.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = f.paste();
    if (reason === 'blur') f.listeners.get('blur')!();
    if (reason === 'context') f.changeContext();
    if (reason === 'disabled') f.disable();
    if (reason === 'destroy') f.action!.destroy();
    if (reason === 'disconnected') f.node.isConnected = false;
    if (reason === 'new paste') await f.paste(f.event('new text'));
    resolve(new Uint8Array([1]).buffer);
    await pending;
    expect(f.onfile).not.toHaveBeenCalled();
  },
);
it('ignores unavailable images and clipboard errors', async () => {
  const f = setup();
  core.invoke
    .mockResolvedValueOnce(new ArrayBuffer(0))
    .mockRejectedValueOnce(new Error('unavailable'));
  await f.paste();
  await f.paste();
  expect(f.onfile).not.toHaveBeenCalled();
});
