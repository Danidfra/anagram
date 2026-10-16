import { isIosNative } from '#src/lib/platform/ios.ts';

/** Keep native iOS screens and portalled dialogs inside the visible safe area. */
export function iosViewport(node: HTMLElement) {
  if (!isIosNative()) return;
  const root = document.documentElement;
  root.classList.add('ios-app');
  node.classList.add('ios-viewport');
  const viewport = window.visualViewport;
  let frame = 0;
  function update() {
    frame = 0;
    // Pinch zoom must remain usable: let the user pan the enlarged document.
    if (viewport && viewport.scale !== 1) return;
    root.style.setProperty('--ios-layout-height', `${window.innerHeight}px`);
    root.style.setProperty('--ios-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
    root.style.setProperty('--ios-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    // The home indicator is below the keyboard, outside the visible viewport.
    const keyboard = window.innerHeight - (viewport?.height ?? window.innerHeight) > 100;
    root.style.setProperty('--ios-bottom-inset', keyboard ? '0px' : 'env(safe-area-inset-bottom)');
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }
  update();
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  return {
    destroy() {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      node.classList.remove('ios-viewport');
      root.classList.remove('ios-app');
      for (const name of [
        '--ios-layout-height',
        '--ios-viewport-height',
        '--ios-viewport-top',
        '--ios-bottom-inset',
      ])
        root.style.removeProperty(name);
    },
  };
}
