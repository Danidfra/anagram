import { isIosNative } from './ios.ts';

/** Fixed-position menus use document coordinates, including on inset iPhones. */
export function appViewportBounds() {
  const native = isIosNative() && document.querySelector('.app-viewport.ios-viewport');
  if (native) return native.getBoundingClientRect();
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
}
