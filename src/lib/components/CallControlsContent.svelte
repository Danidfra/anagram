<script lang="ts">
  import type { Snippet } from 'svelte';
  export let controls: Snippet;
</script>

{@render controls()}
