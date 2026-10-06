<script lang="ts">
  import { observePublicProfile } from '#src/lib/state/publicProfiles.ts';
  import { buildAvatarText } from '#src/utils/avatarText.ts';
  export let name = '';
  export let picture = '';
  export let publicKey = '';
  export let eager = false;
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
    overflow: hidden;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
