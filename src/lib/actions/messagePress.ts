/** Share click, tap, keyboard and long-press menus across message rows. */
export function messagePress(node: HTMLElement, enabled: boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let origin = { x: 0, y: 0 };
  let suppressClickUntil = 0;
  let moved = false;
  const interactive = (target: EventTarget | null) =>
    target instanceof Element &&
    Boolean(
      target.closest(
        'button, a, input, textarea, select, video, audio, [contenteditable], [role="button"]',
      ),
    );
  const open = (x: number, y: number) =>
    node.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      }),
    );
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    window.removeEventListener('scroll', cancel, true);
  };
  const down = (event: PointerEvent) => {
    if (!enabled || !event.isPrimary || interactive(event.target)) return;
    cancel();
    origin = { x: event.clientX, y: event.clientY };
    moved = false;
    if (event.pointerType === 'mouse') return;
    // Only an active long press needs scroll cancellation.
    window.addEventListener('scroll', cancel, { capture: true, passive: true });
    timer = setTimeout(() => {
      cancel();
      suppressClickUntil = Date.now() + 750;
      open(origin.x, origin.y);
    }, 500);
  };
  const move = (event: PointerEvent) => {
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) {
      moved = true;
      cancel();
    }
  };
  const click = (event: MouseEvent) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      !enabled ||
      event.defaultPrevented ||
      interactive(event.target) ||
      moved ||
      window.getSelection()?.toString()
    )
      return;
    event.stopPropagation();
    open(event.clientX, event.clientY);
  };
  const keydown = (event: KeyboardEvent) => {
    if (
      !enabled ||
      event.target !== node ||
      !(
        ['Enter', ' ', 'ContextMenu'].includes(event.key) ||
        (event.shiftKey && event.key === 'F10')
      )
    )
      return;
    event.preventDefault();
    const box = (node.querySelector('.message-content') ?? node).getBoundingClientRect();
    open(box.x + 12, box.y + 12);
  };
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('contextmenu', cancel);
  node.addEventListener('click', click);
  node.addEventListener('keydown', keydown);
  return {
    update(value: boolean) {
      enabled = value;
      if (!value) cancel();
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('contextmenu', cancel);
      node.removeEventListener('click', click);
      node.removeEventListener('keydown', keydown);
    },
  };
}
