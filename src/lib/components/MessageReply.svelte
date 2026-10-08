<script lang="ts">
  import type { MessageReplyPreview } from '#src/types/chat.ts';
  import ProfileName from './ProfileName.svelte';
  export let reply: MessageReplyPreview;
  export let onclick: () => void;
</script>

<button class="reply-preview" {onclick}>
  {#if reply.authorPublicKey && reply.sender !== 'me'}<ProfileName
      publicKey={reply.authorPublicKey}
      fallback={reply.authorName}
    />{:else}{reply.authorName}{/if}{reply.authorName ? ': ' : ''}{reply.text}
</button>
