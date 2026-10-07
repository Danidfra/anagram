<script lang="ts">
  import { observePublicProfile } from '#src/lib/state/publicProfiles.ts';
  import { buildAvatarText } from '#src/utils/avatarText.ts';
  export let name = '';
  export let picture = '';
  export let publicKey = '';
  export let eager = false;
  export let privateGroup = false;
  let failedUrl = '';
  $: profile = observePublicProfile(publicKey);
  $: resolvedPicture =
    $profile?.createdAt !== undefined ? $profile.picture : $profile?.picture || picture;
  export let size = 48;
  export let fontSize: number | undefined = undefined;
  $: initials = buildAvatarText(name);
  function avatarHash(value: string) {
    let hash = 0;
    for (const ch of value.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return hash;
  }
  $: color = [
    '#d65563',
    '#d97706',
    '#7c3aed',
    '#2563eb',
    '#0f766e',
    '#4f46e5',
    '#db2777',
    '#059669',
    '#0284c7',
    '#c2410c',
    '#475569',
    '#b45309',
  ][avatarHash(name || initials) % 12];
</script>

<span
  class="avatar"
  style:width="{size}px"
  style:height="{size}px"
  style:background={color}
  style:font-size={`${fontSize ?? (size === 48 ? 28 : Math.round(size * 0.39))}px`}
>
  {#if resolvedPicture && resolvedPicture !== failedUrl && /^https?:\/\//i.test(resolvedPicture)}<img
      src={resolvedPicture}
      alt=""
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      referrerpolicy="no-referrer"
      onerror={(event) => (failedUrl = event.currentTarget.getAttribute('src') ?? '')}
    />{:else}{initials}{/if}
  {#if privateGroup}
    <span
      class="private-group-badge"
      role="img"
      aria-label="Private group"
      title="Private group"
      style:width={`${Math.max(14, Math.round(size * 0.36))}px`}
      style:height={`${Math.max(14, Math.round(size * 0.36))}px`}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.7" />
        <rect x="3" y="6.5" width="10" height="8" rx="2" fill="currentColor" />
        <path d="M8 9.5v2" stroke="var(--nc-panel-sidebar-bg)" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </span>
  {/if}
</span>

<style>
  .avatar {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-weight: 700;
    color: white;
    font-size: 14px;
    position: relative;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }
  .private-group-badge {
    position: absolute;
    top: -1px;
    left: -1px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--q-primary);
    pointer-events: none;
  }
  .private-group-badge svg {
    width: 100%;
    height: 100%;
  }
</style>
