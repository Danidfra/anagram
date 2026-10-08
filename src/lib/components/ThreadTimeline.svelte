<script lang="ts">
  import { onDestroy, tick, type Snippet } from 'svelte';
  import { threadHistoryPull } from '#src/lib/actions/threadHistoryPull.ts';
  import { translate } from '#src/i18n.ts';
  import Icon from './Icon.svelte';
  export let element: HTMLDivElement;
  export let chatId: string;
  export let publicKey: string = chatId;
  export let label = 'Messages';
  export let firstDay = '';
  export let hasOlder = false;
  export let hasNewer = false;
  export let loading = false;
  export let nearBottom = true;
  export let onolder: () => void;
  export let onnewer: () => void;
  export let onlatest: () => void;
  export let onscroll: () => void = () => {};
  export let onmount: (node: HTMLDivElement) => void = () => {};
  export let children: Snippet;
  let stickyDay = '';
  let frame = 0;
  let active = true;
  function updateDay() {
    if (!element) return;
    const top = element.getBoundingClientRect().top + 38;
    const rows = [...element.querySelectorAll<HTMLElement>('.message-row')];
    stickyDay =
      rows.find((row) => row.getBoundingClientRect().bottom > top)?.dataset.dayLabel ??
      rows.at(-1)?.dataset.dayLabel ??
      '';
  }
  function scrolled() {
    onscroll();
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateDay();
      });
  }
  function mount(node: HTMLDivElement) {
    onmount(node);
    const observer = new ResizeObserver(scrolled);
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
  $: if (firstDay || chatId)
    void tick().then(() => {
      if (active) updateDay();
    });
  onDestroy(() => {
    active = false;
    cancelAnimationFrame(frame);
  });
</script>

<div
  class="messages"
  class:loading-history={loading}
  bind:this={element}
  use:mount
  use:threadHistoryPull={{
    chatId,
    canLoad: () => hasOlder && !loading,
    loading: () => loading,
    load: onolder,
  }}
  tabindex="-1"
  role="log"
  aria-label={label}
  data-testid="chat-thread"
  data-chat-public-key={publicKey}
  onscroll={scrolled}
>
  {#if firstDay}<div class="thread-day-sticky" aria-hidden="true">
      <span>{stickyDay || firstDay}</span>
    </div>{/if}
  {#if hasOlder}<div class="thread-more thread-more--top">
      <button
        class="thread-more__button"
        data-testid="thread-load-older"
        aria-label="Load earlier messages"
        aria-busy={loading}
        disabled={loading}
        onmousedown={(event) => event.preventDefault()}
        onclick={onolder}><Icon name="up" />{$translate('common.more')}</button
      >
    </div>{/if}
  {@render children()}
  {#if hasNewer}<button class="load-older" onclick={onnewer}>Load newer messages</button>{/if}
</div>
{#if !nearBottom}<button class="jump-latest" aria-label="Jump to latest messages" onclick={onlatest}
    ><Icon name="down" /></button
  >{/if}
