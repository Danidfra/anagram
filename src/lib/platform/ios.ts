import { isTauri } from '@tauri-apps/api/core';

export function isIosNative(): boolean {
  return (
    isTauri() &&
    typeof navigator !== 'undefined' &&
    (/iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1))
  );
}
