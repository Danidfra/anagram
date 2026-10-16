import { onLiveThreadMessage } from '#src/lib/state/threadActivity.ts';

interface PositionOptions {
  chatId: string;
  hasNewer?: boolean;
  onchange: (atBottom: boolean) => void;
}
interface Controller {
  latest: (messageId?: string) => void;
}
const controllers = new WeakMap<HTMLElement, Controller>();

/** Explicit navigation; hydration preserves the current reading position. */
export function scrollThreadToLatest(node: HTMLElement | undefined, messageId?: string) {
  if (node) controllers.get(node)?.latest(messageId);
}

export function threadPosition(node: HTMLElement, options: PositionOptions) {
  let anchors: { id: string; offset: number }[] = [];
  let lastTop = node.scrollTop;
  let positioned = false;
  let pendingLatest: { messageId?: string } | undefined;
  let atBottom: boolean | undefined;
  let atLatest = false;
  let disposed = false;
  const observed = new Set<Element>();
  const rows = () => [...node.querySelectorAll<HTMLElement>('.message-row')];
  const maxTop = () => Math.max(0, node.scrollHeight - node.clientHeight);

  function remember(currentRows: HTMLElement[]) {
    const top = node.getBoundingClientRect().top;
    const rects = new Map<number, DOMRect>();
    const rect = (index: number) => {
      let value = rects.get(index);
      if (!value) {
        value = currentRows[index].getBoundingClientRect();
        rects.set(index, value);
      }
      return value;
    };
    // Rows are in vertical display order. Find the first visible row without
    // measuring the entire rendered history on every scroll or hydration update.
    let low = 0;
    let high = currentRows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rect(middle).bottom > top + 38) high = middle;
      else low = middle + 1;
    }
    const start = Math.min(low, currentRows.length - 1);
    // Neighbours cover deletion/edit replacement; boundary rows cover paging
    // that evicts the visible portion of the bounded message window.
    const indices = new Set([
      start,
      start + 1,
      start + 2,
      start - 1,
      start - 2,
      currentRows.length - 1,
      0,
    ]);
    anchors = [...indices]
      .filter((index) => index >= 0 && index < currentRows.length)
      .map((index) => ({ id: currentRows[index].id, offset: rect(index).top - top }));
    lastTop = node.scrollTop;
    const nextBottom = maxTop() - lastTop <= 1;
    atLatest = nextBottom && !options.hasNewer;
    if (nextBottom !== atBottom) {
      atBottom = nextBottom;
      options.onchange(nextBottom);
    }
  }
  function userMoved() {
    positioned = true;
    pendingLatest = undefined;
  }
  function restore() {
    if (disposed) return;
    const currentRows = rows();
    // With browser anchoring disabled, a changed scrollTop is navigation (except
    // clamping after content shrinks). Include it rather than undoing that scroll.
    const movement = node.scrollTop - Math.min(lastTop, maxTop());
    if (Math.abs(movement) > 0.5) userMoved();
    const canNavigate =
      pendingLatest &&
      (!pendingLatest.messageId ||
        currentRows.some(
          (row) =>
            row.id === `message-${pendingLatest!.messageId}` ||
            row.dataset.eventId === pendingLatest!.messageId,
        ));
    // At the latest message, preserve the bottom edge when hydration or media
    // changes row heights. A user scroll takes precedence over that attachment.
    const keepBottom = atLatest && Math.abs(movement) <= 0.5;
    if (currentRows.length && ((!positioned && !pendingLatest) || canNavigate || keepBottom)) {
      node.scrollTop = node.scrollHeight;
      positioned = true;
      pendingLatest = undefined;
    } else {
      const byId = new Map(currentRows.map((row) => [row.id, row]));
      const anchor = anchors.find((entry) => byId.has(entry.id));
      if (anchor) {
        const offset =
          byId.get(anchor.id)!.getBoundingClientRect().top - node.getBoundingClientRect().top;
        const adjustment = offset - anchor.offset + movement;
        if (Math.abs(adjustment) > 0.5) node.scrollTop += adjustment;
      }
    }
    remember(currentRows);
    const retained = new Set<Element>(currentRows);
    for (const row of observed) {
      if (!retained.has(row)) {
        resize.unobserve(row);
        observed.delete(row);
      }
    }
    for (const row of currentRows) {
      if (!observed.has(row)) {
        observed.add(row);
        resize.observe(row);
      }
    }
  }
  const resize = new ResizeObserver(restore);
  const mutation = new MutationObserver(restore);
  const stopLiveMessages = onLiveThreadMessage(({ chatId, id }) => {
    if (chatId !== options.chatId || !atLatest) return;
    // Account for a user scroll whose DOM event has not been dispatched yet.
    if (Math.abs(node.scrollTop - lastTop) > 0.5) return;
    pendingLatest = { messageId: id };
    restore();
  });
  const controller: Controller = {
    latest(messageId) {
      pendingLatest = { messageId };
      restore();
    },
  };
  const scroll = () => {
    if (Math.abs(node.scrollTop - lastTop) > 0.5) restore();
  };
  const wheel = (event: WheelEvent) => {
    if (!event.ctrlKey && event.deltaY) userMoved();
  };
  const key = (event: KeyboardEvent) => {
    if (
      event.target === node &&
      ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
    )
      userMoved();
  };
  controllers.set(node, controller);
  node.addEventListener('scroll', scroll, { passive: true });
  node.addEventListener('wheel', wheel, { passive: true });
  node.addEventListener('touchstart', userMoved, { passive: true });
  node.addEventListener('keydown', key);
  resize.observe(node);
  mutation.observe(node, { subtree: true, childList: true, characterData: true });
  restore();
  return {
    update(next: PositionOptions) {
      const changedChat = next.chatId !== options.chatId;
      if (changedChat) {
        anchors = [];
        positioned = false;
        pendingLatest = undefined;
        atLatest = false;
        lastTop = node.scrollTop;
      }
      if (next.hasNewer) atLatest = false;
      options = next;
      // Content and size observers handle changes within the same chat. Svelte
      // can update the action's options while typing without any layout change.
      if (changedChat) restore();
    },
    destroy() {
      disposed = true;
      stopLiveMessages();
      mutation.disconnect();
      resize.disconnect();
      controllers.delete(node);
      node.removeEventListener('scroll', scroll);
      node.removeEventListener('wheel', wheel);
      node.removeEventListener('touchstart', userMoved);
      node.removeEventListener('keydown', key);
    },
  };
}
