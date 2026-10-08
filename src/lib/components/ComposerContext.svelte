<script lang="ts">
  import type { MessageReplyPreview } from '#src/types/chat.ts';
  import Icon from './Icon.svelte';
  export let editing = false;
  export let reply: MessageReplyPreview | null = null;
  export let oncancel: () => void;
</script>

{#if reply || editing}<div class="composer-context">
    {editing ? 'Editing message' : `Reply to ${reply?.authorName}: ${reply?.text}`}<button
      aria-label="Cancel reply or edit"
      onclick={oncancel}><Icon name="close" /></button
    >
  </div>{/if}
