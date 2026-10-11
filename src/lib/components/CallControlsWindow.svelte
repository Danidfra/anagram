<script lang="ts">
  import { mount, unmount, onDestroy, type Snippet } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import CallControlsContent from './CallControlsContent.svelte';
  export let controls: Snippet;
  export let sessionId = '';
  export let active = false;
  export let onblocked: () => void = () => {};
  let popup: Window | null = null;
  let content: ReturnType<typeof mount> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let previousSession = '';
  function release() {
    clearInterval(poll);
    poll = undefined;
    const previous = content;
    content = undefined;
    popup = null;
    if (previous) void unmount(previous);
  }
  function close() {
    const previous = popup;
    previous?.removeEventListener('pagehide', release);
    release();
    previous?.close();
  }
  export function openWindow() {
    if (!active) return;
    if (popup && !popup.closed) {
      popup.focus();
      return;
    }
    close();
    const next = window.open('about:blank', 'anagram-call-controls', 'popup,width=850,height=300');
    if (!next) {
      onblocked();
      return;
    }
    popup = next;
    next.document.title = $translate('call.controlsWindow');
    next.document.body.className = document.body.className;
    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]'))
      next.document.head.appendChild(node.cloneNode(true));
    const style = next.document.createElement('style');
    style.textContent = `html,body{margin:0;min-height:100%;background:#101820;color:white;font-family:system-ui}
      body{padding:12px;box-sizing:border-box}
      .call-panel__controls{margin:0!important;flex-wrap:wrap!important;gap:8px!important}
      .call-round{width:44px!important;height:44px!important}
      .call-device-menu{position:fixed;top:90px;bottom:auto;left:50%;transform:translateX(-50%);max-height:calc(100vh - 110px);max-width:calc(100vw - 24px)}`;
    next.document.head.appendChild(style);
    const target = next.document.createElement('main');
    target.setAttribute('aria-label', $translate('call.controlsWindow'));
    next.document.body.appendChild(target);
    // A second rendering of the same callbacks/state, with no media or call runtime.
    content = mount(CallControlsContent, { target, props: { controls } });
    next.addEventListener('pagehide', release, { once: true });
    poll = setInterval(() => {
      if (next.closed) release();
    }, 500);
  }
  $: if (!active || sessionId !== previousSession) {
    close();
    previousSession = sessionId;
  }
  onDestroy(close);
</script>
