<script lang="ts">
  import { iosViewport } from '#src/lib/actions/iosViewport.ts';
  import { isIosNative } from '#src/lib/platform/ios.ts';
  import '#src/lib/platform/ios.css';
  let { children } = $props();
  const ios = isIosNative();
</script>

{#if ios}<div class="app-viewport" use:iosViewport>{@render children()}</div>
{:else}{@render children()}{/if}
