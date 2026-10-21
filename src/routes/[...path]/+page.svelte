<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { publicGroupLinkTarget } from '#src/utils/publicGroupLink.ts';
  import PwaControls from '#src/lib/components/PwaControls.svelte';
  import AppPrompts from '#src/lib/components/AppPrompts.svelte';
  import { hasPendingLogoutCleanup } from '#src/utils/logoutState.ts';
  import { applyThemeAccent, readThemeAccent, ACCENT_STORAGE_KEY } from '#src/utils/themeAccent.ts';
  import { incomingMessageBanner } from '#src/lib/platform/ui.ts';
  import { updateAppBadge } from '#src/lib/platform/appBadge.ts';
  import '#src/app.css';
  import '#src/lib/components/shell.css';
  let authenticated = false;
  let ready = false;
  let cleaning = false;
  let cleanupBusy = false;
  let cleanupError = '';
  async function resumeLogout() {
    if (cleanupBusy) return;
    cleaning = true;
    authenticated = false;
    cleanupBusy = true;
    cleanupError = '';
    try {
      const { useNostrStore } = await import('#src/stores/nostrStore.svelte.ts');
      await useNostrStore().logout();
      window.location.replace('/');
    } catch (error) {
      cleanupError =
        error instanceof Error ? error.message : 'Unable to finish logout. Please retry.';
    } finally {
      cleanupBusy = false;
    }
  }
  onMount(() => {
    applyThemeAccent(readThemeAccent());
    const syncAccent = (event: StorageEvent) => {
      if (event.key === ACCENT_STORAGE_KEY || event.key === null)
        applyThemeAccent(readThemeAccent());
    };
    window.addEventListener('storage', syncAccent);
    document.body.classList.toggle(
      'body--dark',
      (localStorage.getItem('anagram-theme') ?? 'dark') === 'dark',
    );
    // Clean-URL hosting or an older app-shell cache can send share pages here.
    // Keep the validated destination in the route throughout login and onboarding.
    if (/^\/join\/chat(?:\.html)?\/?$/.test(window.location.pathname)) {
      const target = publicGroupLinkTarget(window.location.href);
      if (target) void goto(target, { replace: true });
    }
    authenticated =
      Boolean(localStorage.getItem('npub')) && !localStorage.getItem('anagram-onboarding-pending');
    if (!authenticated) void updateAppBadge(0);
    ready = true;
    window.addEventListener('anagram-logout', resumeLogout);
    if (hasPendingLogoutCleanup()) void resumeLogout();
    return () => {
      window.removeEventListener('storage', syncAccent);
      window.removeEventListener('anagram-logout', resumeLogout);
    };
  });
</script>

<PwaControls />
<AppPrompts />
{#if ready}
  {#if cleaning}
    <main class="logout-cleanup" aria-live="polite">
      <p>{cleanupBusy ? 'Logging out…' : cleanupError}</p>
      {#if !cleanupBusy}<button onclick={resumeLogout}>Retry logout</button>{/if}
    </main>
  {:else if authenticated}
    {#await import('#src/lib/components/Shell.svelte') then module}<module.default />{/await}
  {:else}
    {#await import('#src/lib/components/Auth.svelte') then module}<module.default
        onlogin={() => (authenticated = true)}
      />{/await}
  {/if}
{/if}
{#if $incomingMessageBanner}<div class="message-banner" role="status">
    {$incomingMessageBanner}
  </div>{/if}

<style>
  .logout-cleanup {
    min-height: 100dvh;
    display: grid;
    place-content: center;
    gap: 1rem;
    padding: 2rem;
    text-align: center;
  }
</style>
