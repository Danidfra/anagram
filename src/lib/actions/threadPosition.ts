interface PositionOptions {
  chatId: string;
  onchange: (atBottom: boolean) => void;
}
interface Controller {
  latest: (messageId?: string) => void;
  revision: () => number;
}
const controllers = new WeakMap<HTMLElement, Controller>();

/** Explicit navigation only; hydration never requests a trip to the bottom. */
export function scrollThreadToLatest(node: HTMLElement | undefined, messageId?: string) {
  if (node) controllers.get(node)?.latest(messageId);
}

/** A send completing must not override scrolling performed while it was pending. */
export function prepareThreadScrollToLatest(node: HTMLElement | undefined) {
  const controller = node && controllers.get(node);
  const revision = controller?.revision();
  return (messageId?: string) => {
    if (
      node &&
      controller &&
      controllers.get(node) === controller &&
      controller.revision() === revision
    )
      controller.latest(messageId);
  };
}

export function threadPosition(node: HTMLElement, options: PositionOptions) {
  let anchors: { id: string; offset: number }[] = [];
  let lastTop = node.scrollTop;
  let positioned = false;
  let revision = 0;
  let pendingLatest: { messageId?: string } | undefined;
  let atBottom: boolean | undefined;
  let disposed = false;
  const observed = new Set<Element>();
  const rows = () => [...node.querySelectorAll<HTMLElement>('.message-row')];
  const maxTop = () => Math.max(0, node.scrollHeight - node.clientHeight);

  function remember(currentRows: HTMLElement[]) {
    const top = node.getBoundingClientRect().top;
    const positions = currentRows.map((row) => ({
      id: row.id,
      offset: row.getBoundingClientRect().top - top,
      bottom: row.getBoundingClientRect().bottom - top,
    }));
    const firstVisible = positions.findIndex((row) => row.bottom > 38);
    const start = Math.max(0, firstVisible);
    // Keep fallback rows for deletion, edit replacement and bounded-window eviction.
    anchors = [...positions.slice(start), ...positions.slice(0, start).reverse()];
    lastTop = node.scrollTop;
    const nextBottom = maxTop() - lastTop <= 1;
    if (nextBottom !== atBottom) {
      atBottom = nextBottom;
      options.onchange(nextBottom);
    }
  }
  function userMoved() {
    revision++;
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
        currentRows.some((row) => row.id === `message-${pendingLatest!.messageId}`));
    if (currentRows.length && ((!positioned && !pendingLatest) || canNavigate)) {
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
  const controller: Controller = {
    revision: () => revision,
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
      if (next.chatId !== options.chatId) {
        anchors = [];
        positioned = false;
        pendingLatest = undefined;
        revision++;
        lastTop = node.scrollTop;
      }
      options = next;
      restore();
    },
    destroy() {
      disposed = true;
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
