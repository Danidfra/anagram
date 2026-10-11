/** Fit the complete name design to its visible video frame. Each window observes
 * its own geometry; custom CSS and persisted preferences are never rewritten. */
export function fitCallName(node: HTMLElement) {
  const view = node.ownerDocument.defaultView!;
  const design = node.shadowRoot!.querySelector<HTMLElement>('[data-call-name-design]')!;
  const label = design.querySelector<HTMLElement>('.customname')!;
  let pending: number | undefined;
  let disposed = false;

  function fit() {
    pending = undefined;
    if (disposed || !node.isConnected) return;
    // Measure the original design, never an already scaled result.
    design.style.transform = 'none';
    const frame = node.getBoundingClientRect();
    const name = label.getBoundingClientRect();
    if (!frame.width || !frame.height || !name.width || !name.height) return;
    const scale = Math.min(1, (frame.height * 0.1) / name.height, (frame.width * 0.8) / name.width);
    const gap = 16 * scale;
    const x = gap - (name.left - frame.left) * scale;
    const y = frame.height - gap - (name.bottom - frame.top) * scale;
    design.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${x}, ${y})`;
  }
  function update() {
    if (!disposed && pending === undefined) pending = view.requestAnimationFrame(fit);
  }
  const observer = new view.ResizeObserver(update);
  observer.observe(node);
  observer.observe(label);
  update();
  return {
    update,
    destroy() {
      disposed = true;
      observer.disconnect();
      if (pending !== undefined) view.cancelAnimationFrame(pending);
    },
  };
}
