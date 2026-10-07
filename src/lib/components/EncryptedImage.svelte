<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { MessageAttachmentMetadata } from '#src/types/chat.ts';
  import { encryptedMediaService } from '#src/services/encryptedMediaService.ts';
  import { isEncryptedAttachment } from '#src/utils/messageAttachments.ts';
  import { translate } from '#src/i18n.ts';
  import Icon from './Icon.svelte';
  export let attachment: MessageAttachmentMetadata;
  export let alt = 'Attachment';
  export let onopen: () => void = () => {};
  // Encrypted images are only downloaded and decrypted once they are within this distance of the
  // viewport, so opening a long conversation does not fetch every image in it.
  const PRELOAD_ROOT_MARGIN = '600px 0px';
  let placeholder: HTMLElement | undefined;
  let observer: IntersectionObserver | null = null;
  let nearViewport = false;
  let objectUrl = '';
  let failed = false;
  let acquired: MessageAttachmentMetadata | null = null;
  let generation = 0;
  let loadedIdentity = '';
  $: identity = attachment.encryption
    ? [
        attachment.url,
        attachment.sha256 ?? '',
        attachment.mimeType,
        attachment.encryption.key,
        attachment.encryption.nonce,
      ].join('|')
    : '';
  $: if (placeholder && !nearViewport && !observer) watchViewport(placeholder);
  $: if (nearViewport && identity !== loadedIdentity) load(identity);
  function stopWatchingViewport() {
    observer?.disconnect();
    observer = null;
  }
  function watchViewport(element: HTMLElement) {
    if (typeof IntersectionObserver === 'undefined') {
      nearViewport = true;
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          nearViewport = true;
          stopWatchingViewport();
        }
      },
      { rootMargin: PRELOAD_ROOT_MARGIN },
    );
    observer.observe(element);
  }
  function release() {
    if (acquired) {
      encryptedMediaService.releaseDecryptedObjectUrl(acquired);
      acquired = null;
    }
    objectUrl = '';
  }
  // The ciphertext URL is never used as an image source; only the verified, decrypted object URL.
  function load(nextIdentity: string) {
    loadedIdentity = nextIdentity;
    generation += 1;
    const current = generation;
    release();
    failed = false;
    if (!nextIdentity || !isEncryptedAttachment(attachment)) return;
    const snapshot: MessageAttachmentMetadata = {
      ...attachment,
      encryption: { ...attachment.encryption },
    };
    acquired = snapshot;
    encryptedMediaService.acquireDecryptedObjectUrl(snapshot).then(
      (url) => {
        if (current === generation) objectUrl = url;
      },
      () => {
        // A failed load is not cached, so there is no reference left to release.
        if (acquired === snapshot) acquired = null;
        if (current === generation) failed = true;
      },
    );
  }
  onDestroy(() => {
    generation += 1;
    stopWatchingViewport();
    release();
  });
</script>

{#if objectUrl}<button
    type="button"
    class="encrypted-image"
    data-testid="message-encrypted-image"
    aria-label={alt}
    onclick={(event) => {
      event.stopPropagation();
      onopen();
    }}><img src={objectUrl} {alt} /></button
  >{:else}<div
    bind:this={placeholder}
    class="encrypted-placeholder"
    role="img"
    aria-label={alt}
    data-testid={failed ? 'message-encrypted-image-failed' : 'message-encrypted-image-pending'}
  >
    {#if failed}<button
        type="button"
        class="icon-button"
        aria-label={$translate('message.encryptedMedia.retry')}
        title={$translate('message.encryptedMedia.failed')}
        onclick={(event) => {
          event.stopPropagation();
          load(identity);
        }}><Icon name="refresh" /></button
      >{:else}<Icon name="lock" />{/if}
  </div>{/if}

<style>
  .encrypted-image {
    display: block;
    padding: 0;
    border: 0;
    background: none;
    cursor: zoom-in;
  }
  img {
    display: block;
    max-width: min(100%, 480px);
    max-height: 400px;
    border-radius: 10px;
    margin: 10px 0;
  }
  .encrypted-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 160px;
    max-width: 100%;
    height: 120px;
    margin: 10px 0;
    border-radius: 10px;
    color: var(--nc-text-secondary);
    background: var(--nc-surface-soft);
  }
</style>
