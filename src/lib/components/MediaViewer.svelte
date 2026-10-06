<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { openExternalHttpUrl } from '#src/utils/externalLinks.ts';
  export let url: string;
  export let name = 'attachment';
  let downloadError = '';
  async function download() {
    try {
      const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error();
      const blob = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = blob;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(blob), 1000);
    } catch {
      downloadError = 'Download failed. Try opening the original image.';
    }
  }
  export let onclose: () => void;
  let scale = 1,
    x = 0,
    y = 0,
    dragging = false;
  let dialog: HTMLDivElement;
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.focus();
    return () => previous?.focus();
  });
  function reset() {
    scale = 1;
    x = 0;
    y = 0;
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape') onclose();
    if (event.key === '+') scale = Math.min(5, scale + 0.25);
    if (event.key === '-') scale = Math.max(1, scale - 0.25);
    if (event.key === 'Tab') {
      const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
      const first = buttons[0],
        last = buttons.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === dialog)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="image-viewer"
  role="dialog"
  aria-modal="true"
  aria-label="Image attachment"
  tabindex="-1"
  bind:this={dialog}
  onkeydown={keyboard}
>
  <header>
    <button
      class="icon-button"
      aria-label="Zoom out"
      onclick={() => (scale = Math.max(1, scale - 0.25))}>−</button
    ><button
      class="icon-button"
      aria-label="Zoom in"
      onclick={() => (scale = Math.min(5, scale + 0.25))}>+</button
    ><button onclick={reset}>Reset zoom</button><button onclick={() => openExternalHttpUrl(url)}
      >Open original</button
    ><button onclick={download}>Download image</button><button
      class="icon-button"
      aria-label="Close image"
      onclick={onclose}><Icon name="close" /></button
    >
  </header>
  {#if downloadError}<p role="alert">{downloadError}</p>{/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="image-canvas"
    onwheel={(e) => {
      e.preventDefault();
      scale = Math.max(1, Math.min(5, scale + (e.deltaY < 0 ? 0.15 : -0.15)));
    }}
    onpointerdown={(e) => {
      dragging = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onpointerup={() => (dragging = false)}
    onpointermove={(e) => {
      if (dragging && scale > 1) {
        x += e.movementX;
        y += e.movementY;
      }
    }}
  >
    <img
      src={url}
      alt="Attachment"
      draggable="false"
      referrerpolicy="no-referrer"
      style:transform={`translate(${x}px,${y}px) scale(${scale})`}
    />
  </div>
</div>

<style>
  .image-viewer {
    position: fixed;
    inset: 0;
    background: #080d14f5;
    z-index: 100;
    display: flex;
    flex-direction: column;
    color: white;
  }
  header {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    align-items: center;
    padding: 12px;
  }
  header .icon-button {
    color: white;
  }
  .image-canvas {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: grid;
    place-items: center;
    touch-action: none;
  }
  img {
    max-width: 100%;
    max-height: calc(100dvh - 70px);
    object-fit: contain;
    user-select: none;
  }
</style>
