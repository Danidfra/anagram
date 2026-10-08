<script lang="ts">
  import type { Snippet } from 'svelte';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  export let name: string;
  export let subtitle: string;
  export let picture = '';
  export let publicKey = '';
  export let privateGroup = false;
  export let publicGroup = false;
  export let label: string | undefined = undefined;
  export let onopen: () => void;
  export let onback: () => void;
  export let actions: Snippet | undefined = undefined;
</script>

<header class="thread-header">
  <button class="icon-button mobile-back" aria-label="Back to chats" onclick={onback}
    ><Icon name="back" /></button
  >
  <Avatar {name} {picture} {publicKey} {privateGroup} {publicGroup} eager />
  <button class="thread-identity" aria-label={label} onclick={onopen}
    ><strong>{name}</strong><small>{subtitle}</small></button
  >
  <div class="header-actions">{@render actions?.()}</div>
</header>
