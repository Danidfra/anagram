import { isTauri } from '@tauri-apps/api/core';

type BadgeNavigator = Navigator & {
  setAppBadge?: (count: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

let desired: number | undefined;
let revision = 0;
let pending = Promise.resolve();

/** Serialize OS updates so an older count cannot overwrite a read/logout clear. */
export function updateAppBadge(value: number): Promise<void> {
  if (typeof navigator === 'undefined') return Promise.resolve();
  // Leave mobile notification/launcher handling unchanged, including iPad desktop mode.
  if (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  )
    return Promise.resolve();
  const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (count === desired) return pending;
  desired = count;
  const request = ++revision;
  pending = pending
    .then(async () => {
      if (request !== revision) return;
      if (!isTauri()) {
        const browser = navigator as BadgeNavigator;
        if (count) await browser.setAppBadge?.(count);
        else await browser.clearAppBadge?.();
        return;
      }
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      if (!/Windows/i.test(navigator.userAgent)) {
        await window.setBadgeCount(count || undefined);
        return;
      }
      if (!count) {
        await window.setOverlayIcon(undefined);
        return;
      }
      // Windows exposes an icon overlay rather than a numeric badge. Draw only on changes.
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.fillStyle = '#d32f2f';
      context.beginPath();
      context.arc(16, 16, 16, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#ffffff';
      context.font = `bold ${count > 99 ? 14 : count > 9 ? 20 : 24}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(count > 99 ? '99+' : String(count), 16, 17);
      const { Image } = await import('@tauri-apps/api/image');
      const image = await Image.new(
        new Uint8Array(context.getImageData(0, 0, 32, 32).data),
        32,
        32,
      );
      try {
        await window.setOverlayIcon(image);
      } finally {
        await image.close();
      }
    })
    .catch(() => {
      // Badges are optional: unsupported launchers or denied browser APIs must not interrupt chat.
    });
  return pending;
}
