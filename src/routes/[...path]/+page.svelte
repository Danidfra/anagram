<script lang="ts">
  import { onMount } from 'svelte';
  import PwaControls from '#src/lib/components/PwaControls.svelte';
  import Auth from '#src/lib/components/Auth.svelte';
  import Shell from '#src/lib/components/Shell.svelte';
  import { notices } from '#src/lib/platform/ui.ts';
  import '#src/app.css';
  import '#src/lib/components/shell.css';
  let authenticated = false;
  let ready = false;
  onMount(() => {
    document.body.classList.toggle(
      'body--dark',
      (localStorage.getItem('anagram-theme') ?? 'dark') === 'dark',
    );
    authenticated =
      Boolean(localStorage.getItem('npub')) && !localStorage.getItem('anagram-onboarding-pending');
    ready = true;
  });
</script>

<PwaControls />
{#if ready}{#if authenticated}<Shell />{:else}<Auth
      onlogin={() => (authenticated = true)}
    />{/if}{/if}
<div class="notices" aria-live="polite">
  {#each $notices as notice (notice.id)}<div class:error={notice.type === 'negative'}>
      {notice.message}
    </div>{/each}
</div>
