import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { messagePress } from '#src/lib/actions/messagePress.ts';

class TestElement extends EventTarget {
  closest() {
    return null;
  }
}
class TestMouseEvent extends Event {
  constructor(type: string, options: MouseEventInit) {
    super(type, options);
  }
}
let windowTarget: EventTarget;
let listeners: Set<EventListenerOrEventListenerObject>;
beforeEach(() => {
  vi.useFakeTimers();
  windowTarget = new EventTarget();
  listeners = new Set();
  const add = windowTarget.addEventListener.bind(windowTarget);
  const remove = windowTarget.removeEventListener.bind(windowTarget);
  vi.spyOn(windowTarget, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'scroll' && listener) listeners.add(listener);
    add(type, listener, options);
  });
  vi.spyOn(windowTarget, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'scroll' && listener) listeners.delete(listener);
    remove(type, listener, options);
  });
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('Element', TestElement);
  vi.stubGlobal('MouseEvent', TestMouseEvent);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function row() {
  const node = new TestElement();
  const action = messagePress(node as unknown as HTMLElement, true);
  const opened = vi.fn();
  node.addEventListener('contextmenu', opened);
  const press = (pointerType = 'touch') =>
    node.dispatchEvent(
      Object.assign(new Event('pointerdown'), {
        isPrimary: true,
        pointerType,
        clientX: 10,
        clientY: 10,
      }),
    );
  return { node, action, opened, press };
}
it('does not attach idle scroll listeners even with hundreds of loaded messages', () => {
  const rows = Array.from({ length: 500 }, row);
  expect(listeners.size).toBe(0);
  rows[0].press('mouse');
  expect(listeners.size).toBe(0);
  rows[1].press();
  expect(listeners.size).toBe(1);
  windowTarget.dispatchEvent(new Event('scroll'));
  expect(listeners.size).toBe(0);
  vi.advanceTimersByTime(600);
  expect(rows[1].opened).not.toHaveBeenCalled();
  rows.forEach(({ action }) => action.destroy());
});
it('releases the scroll listener after long press, pointer release, disable and destroy', () => {
  const r = row();
  r.press();
  vi.advanceTimersByTime(500);
  expect(r.opened).toHaveBeenCalledOnce();
  expect(listeners.size).toBe(0);
  for (const type of ['pointerup', 'pointercancel']) {
    r.press();
    expect(listeners.size).toBe(1);
    r.node.dispatchEvent(new Event(type));
    expect(listeners.size).toBe(0);
  }
  r.press();
  r.action.update(false);
  expect(listeners.size).toBe(0);
  r.action.update(true);
  r.press();
  expect(listeners.size).toBe(1);
  r.action.destroy();
  expect(listeners.size).toBe(0);
  vi.advanceTimersByTime(600);
  expect(r.opened).toHaveBeenCalledOnce();
});
