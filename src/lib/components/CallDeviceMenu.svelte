<script lang="ts">
  import { translate } from '#src/i18n.ts';
  import Icon from './Icon.svelte';
  import { mediaDeviceChoices } from '#src/utils/mediaDeviceChoices.ts';
  export let kind: 'microphone' | 'camera' | 'speaker';
  export let prefix = 'call';
  export let devices: MediaDeviceInfo[] = [];
  export let selected = '';
  export let disabled = false;
  export let supported = true;
  export let canRequest = false;
  export let onrefresh: () => unknown = () => {};
  export let onselect: (id: string) => unknown;
  export let onrequest: () => unknown = () => {};
  let open = false;
  let picker: HTMLDivElement;
  function listen(node: HTMLElement) {
    const view = node.ownerDocument.defaultView!;
    const pointer = (event: PointerEvent) => {
      if (open && !node.contains(event.target as Node)) open = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') open = false;
    };
    view.addEventListener('pointerdown', pointer);
    view.addEventListener('keydown', key);
    return {
      destroy() {
        view.removeEventListener('pointerdown', pointer);
        view.removeEventListener('keydown', key);
      },
    };
  }
  $: choices = mediaDeviceChoices(devices);
  $: label = `call.choose${kind[0].toUpperCase()}${kind.slice(1)}`;
  function choose(id: string) {
    open = false;
    void onselect(id);
  }
</script>

<div bind:this={picker} use:listen class="call-device-picker">
  <button
    class="call-device-toggle"
    {disabled}
    aria-label={$translate(label)}
    aria-expanded={open}
    data-testid={`${prefix}-${kind}-menu`}
    onclick={() => {
      open = !open;
      if (open) void onrefresh();
    }}
    ><span class="call-device-label">{$translate(`call.${kind}`)}</span><Icon name="down" /></button
  >
  {#if open}
    <div
      class="call-device-menu"
      data-call-device-menu
      role="group"
      aria-label={$translate(`call.${kind}`)}
    >
      <strong>{$translate(`call.${kind}`)}</strong>
      {#if supported || kind === 'speaker'}<button
          class:chosen={!selected}
          data-testid={`${prefix}-${kind}-default`}
          onclick={() => choose('')}>{$translate('call.systemDefault')}</button
        >{/if}
      {#if supported}
        {#each choices as device, index (device.deviceId)}<button
            class:chosen={selected === device.deviceId}
            data-testid={`${prefix}-${kind}-source-${index}`}
            onclick={() => choose(device.deviceId)}
            >{device.label || `${$translate(`call.${kind}`)} ${index + 1}`}</button
          >{/each}
        {#if canRequest}<button
            onclick={() => {
              open = false;
              void onrequest();
            }}>{$translate('call.chooseSpeaker')}</button
          >{/if}
      {:else}<p>
          {$translate(kind === 'speaker' ? 'call.speakerUnavailable' : 'call.error.peerUpgrade')}
        </p>{/if}
    </div>
  {/if}
</div>

<style>
  .call-device-label {
    display: none;
  }
  .call-device-picker {
    position: relative;
    display: flex;
    justify-content: center;
  }
  .call-device-toggle {
    background: transparent;
    border: 0;
    color: inherit;
    padding: 2px;
  }
  .call-device-menu {
    position: absolute;
    z-index: 4;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    width: 240px;
    max-width: 80vw;
    max-height: 45vh;
    overflow: auto;
    background: #222b35;
    color: #fff;
    padding: 8px;
    border-radius: 6px;
    box-shadow: 0 6px 24px #0009;
  }
  .call-device-menu strong,
  .call-device-menu p {
    display: block;
    padding: 8px;
  }
  .call-device-menu button {
    display: block;
    text-align: left;
    width: 100%;
    padding: 12px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
  }
  .call-device-menu button:hover,
  .call-device-menu .chosen {
    background: #315a7b;
  }
  @media (max-width: 599px), (max-height: 500px) {
    :global(.call-panel) .call-device-label {
      display: inline;
    }
    :global(.call-panel) .call-device-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 44px;
      width: 100%;
      padding: 8px;
      border-radius: 12px;
      background: #ffffff14;
    }
    :global(.call-panel) .call-device-menu {
      position: fixed;
      bottom: max(96px, var(--app-bottom-inset, env(safe-area-inset-bottom)));
      left: 50%;
    }
  }
</style>
