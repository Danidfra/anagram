<script lang="ts">
  import type { Snippet } from 'svelte';
  import ModalFrame from './ModalFrame.svelte';
  export let onclose: () => void;
  export let children: Snippet;
</script>

<ModalFrame title="Pinned message" {onclose}>
  <div class="pin-preview">
    {@render children()}
    <p class="pin-preview-hint">Scroll up in the conversation to read surrounding messages.</p>
  </div>
</ModalFrame>

<style>
  .pin-preview {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .pin-preview-hint {
    margin: 16px 0 0;
    color: var(--nc-text-secondary);
    font-size: 12px;
  }
</style>
