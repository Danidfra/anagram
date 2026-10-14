import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  enabled: false,
  badge: vi.fn(),
  overlay: vi.fn(),
  image: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.enabled }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setBadgeCount: native.badge, setOverlayIcon: native.overlay }),
}));
vi.mock('@tauri-apps/api/image', () => ({ Image: { new: native.image } }));
let update: typeof import('#src/lib/platform/appBadge.ts').updateAppBadge;
const set = vi.fn(),
  clear = vi.fn();
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  native.enabled = false;
  native.image.mockResolvedValue({ close: native.close });
  vi.stubGlobal('navigator', {
    userAgent: 'Linux desktop',
    setAppBadge: set,
    clearAppBadge: clear,
  });
  update = (await import('#src/lib/platform/appBadge.ts')).updateAppBadge;
});
afterEach(() => vi.unstubAllGlobals());

it('updates PWA counts once per change and clears read or invalid totals', async () => {
  await update(3);
  await update(3);
  expect(set).toHaveBeenCalledExactlyOnceWith(3);
  await update(0);
  await update(-1);
  await update(NaN);
  expect(clear).toHaveBeenCalledOnce();
  expect(native.badge).not.toHaveBeenCalled();
});
it('coalesces a synchronous burst to the final count', async () => {
  await Promise.all([update(1), update(2), update(8)]);
  expect(set).toHaveBeenCalledExactlyOnceWith(8);
});
it('serializes an in-flight update before the final logout clear', async () => {
  let finish!: () => void;
  set.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const first = update(1);
  await vi.waitFor(() => expect(set).toHaveBeenCalledOnce());
  const stale = update(7);
  const logout = update(0);
  expect(clear).not.toHaveBeenCalled();
  finish();
  await Promise.all([first, stale, logout]);
  expect(set).toHaveBeenCalledExactlyOnceWith(1);
  expect(clear).toHaveBeenCalledOnce();
});
it('ignores absent and rejected browser APIs without retries', async () => {
  vi.stubGlobal('navigator', { userAgent: 'Linux desktop' });
  await update(1);
  vi.stubGlobal('navigator', { userAgent: 'Linux desktop', setAppBadge: set });
  set.mockRejectedValue(new Error('Permission denied'));
  await update(2);
  await update(2);
  expect(set).toHaveBeenCalledOnce();
  set.mockResolvedValue(undefined);
  await update(3);
  expect(set).toHaveBeenLastCalledWith(3);
});
it.each(['Macintosh', 'Linux desktop'])(
  'uses native counts for %s and clears with undefined',
  async (userAgent) => {
    native.enabled = true;
    vi.stubGlobal('navigator', { userAgent });
    await update(12);
    await update(0);
    expect(native.badge.mock.calls).toEqual([[12], [undefined]]);
    expect(native.overlay).not.toHaveBeenCalled();
  },
);
it.each(['Android', 'iPhone', 'iPad', 'Macintosh'])(
  'leaves mobile badges alone for %s',
  async (userAgent) => {
    native.enabled = true;
    vi.stubGlobal('navigator', {
      userAgent,
      maxTouchPoints: 5,
      setAppBadge: set,
      clearAppBadge: clear,
    });
    await update(4);
    await update(0);
    expect(native.badge).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  },
);
it('draws Windows overlays only on changes, caps the label and releases native images on failure', async () => {
  native.enabled = true;
  vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' });
  const context = {
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(32 * 32 * 4) }),
  };
  vi.stubGlobal('document', { createElement: vi.fn(() => ({ getContext: () => context })) });
  await update(123);
  await update(123);
  expect(context.fillText).toHaveBeenCalledExactlyOnceWith('99+', 16, 17);
  expect(native.image).toHaveBeenCalledExactlyOnceWith(expect.any(Uint8Array), 32, 32);
  expect(native.close).toHaveBeenCalledOnce();
  native.overlay.mockRejectedValueOnce(new Error('Unavailable'));
  await update(2);
  expect(native.close).toHaveBeenCalledTimes(2);
  await update(0);
  expect(native.overlay).toHaveBeenLastCalledWith(undefined);
  expect(native.image).toHaveBeenCalledTimes(2);
});
