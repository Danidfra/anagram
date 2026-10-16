interface NewerScrollOptions {
  chatId: string;
  canLoad: () => boolean;
  load: () => Promise<void>;
}

// Load one bounded page as the reader approaches the end. DOM changes and
// restored scroll positions must not drain the rest of the history by themselves.
export function threadNewerScroll(node: HTMLElement, options: NewerScrollOptions) {
  let previousTop = node.scrollTop;
  let downwardIntent = false;
  let touchY: number | undefined;
  let pending = false;
  function check() {
    if (!downwardIntent || pending || !options.canLoad()) return;
    if (node.scrollHeight - node.clientHeight - node.scrollTop > 160) return;
    downwardIntent = false;
    pending = true;
    void options.load().finally(() => {
      pending = false;
      downwardIntent = false;
      previousTop = node.scrollTop;
    });
  }
  function scroll() {
    const down = node.scrollTop > previousTop;
    previousTop = node.scrollTop;
    if (down) check();
  }
  function wheel(event: WheelEvent) {
    if (event.ctrlKey) return;
    downwardIntent = event.deltaY > 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX);
    check();
  }
  function touchStart(event: TouchEvent) {
    touchY = event.touches.length === 1 ? event.touches[0].clientY : undefined;
    downwardIntent = false;
  }
  function touchMove(event: TouchEvent) {
    if (touchY === undefined || event.touches.length !== 1) return;
    const y = event.touches[0].clientY;
    downwardIntent = y < touchY;
    touchY = y;
    check();
  }
  function key(event: KeyboardEvent) {
    if (event.target !== node) return;
    downwardIntent =
      ['ArrowDown', 'PageDown', 'End'].includes(event.key) ||
      (event.key === ' ' && !event.shiftKey);
    check();
  }
  function pointer() {
    // Includes dragging the native scrollbar; the scroll event checks direction.
    downwardIntent = true;
  }
  node.addEventListener('scroll', scroll, { passive: true });
  node.addEventListener('wheel', wheel, { passive: true });
  node.addEventListener('touchstart', touchStart, { passive: true });
  node.addEventListener('touchmove', touchMove, { passive: true });
  node.addEventListener('keydown', key);
  node.addEventListener('pointerdown', pointer, { passive: true });
  return {
    update(next: NewerScrollOptions) {
      if (next.chatId !== options.chatId) {
        downwardIntent = false;
        touchY = undefined;
        previousTop = node.scrollTop;
      }
      options = next;
    },
    destroy() {
      node.removeEventListener('scroll', scroll);
      node.removeEventListener('wheel', wheel);
      node.removeEventListener('touchstart', touchStart);
      node.removeEventListener('touchmove', touchMove);
      node.removeEventListener('keydown', key);
      node.removeEventListener('pointerdown', pointer);
    },
  };
}
