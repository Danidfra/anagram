<template>
  <div ref="rootRef" class="attachment-media" :data-kind="kind" data-testid="message-encrypted-media">
    <video
      v-if="mediaSrc && kind === 'video'"
      ref="playerRef"
      class="attachment-media__player"
      data-testid="message-encrypted-video"
      controls
      playsinline
      preload="metadata"
      :src="mediaSrc"
      :aria-label="label"
    />
    <audio
      v-else-if="mediaSrc && kind === 'audio'"
      ref="playerRef"
      class="attachment-media__player"
      data-testid="message-encrypted-audio"
      controls
      preload="metadata"
      :src="mediaSrc"
      :aria-label="label"
    />
    <div
      v-else
      class="attachment-media__placeholder"
      :class="`attachment-media__placeholder--${kind}`"
      data-testid="message-encrypted-media-placeholder"
    >
      <q-spinner
        v-if="isLoading"
        class="attachment-media__action"
        size="24px"
        data-testid="message-encrypted-media-loading"
      />
      <q-btn
        v-else
        round
        unelevated
        color="primary"
        class="attachment-media__action"
        :icon="hasFailed ? 'refresh' : 'play_arrow'"
        :aria-label="hasFailed ? $t('message.encryptedMedia.retry') : $t('message.encryptedMedia.play')"
        data-testid="message-encrypted-media-load"
        @click.stop="handlePlayRequest"
      />
      <div class="attachment-media__details">
        <span class="attachment-media__label">{{ label }}</span>
        <span v-if="hasFailed" class="text-negative" data-testid="message-encrypted-media-failed">
          {{ $t('message.encryptedMedia.failed') }}
        </span>
        <span v-else-if="sizeLabel" class="attachment-media__caption">{{ sizeLabel }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { encryptedMediaService } from 'src/services/encryptedMediaService';
import {
  createEncryptedMediaLoader,
  type EncryptedMediaLoadState,
} from 'src/services/encryptedMediaLoader';
import type { MessageAttachmentMetadata } from 'src/types/chat';
import { formatMediaByteSize, resolveEncryptedMediaKind } from 'src/utils/encryptedMedia';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{
  attachment: MessageAttachmentMetadata;
  label: string;
  // Decrypt automatically once the attachment is near the viewport. Only set for media from
  // trusted senders (including our own), mirroring how images are revealed.
  autoLoad?: boolean;
}>();

// Like images, nothing is downloaded until the attachment is close to the viewport, so a long
// conversation never fetches all of its video and audio in the background.
const AUTO_LOAD_ROOT_MARGIN = '200px 0px';

const rootRef = ref<HTMLElement | null>(null);
const playerRef = ref<HTMLMediaElement | null>(null);
const loadState = ref<EncryptedMediaLoadState>({ status: 'idle', objectUrl: '' });
const loader = createEncryptedMediaLoader(encryptedMediaService, (state) => {
  loadState.value = state;
});
let viewportObserver: IntersectionObserver | null = null;
let shouldPlayWhenReady = false;

const mediaSrc = computed(() => loadState.value.objectUrl);
const isLoading = computed(() => loadState.value.status === 'loading');
const hasFailed = computed(() => loadState.value.status === 'failed');
const kind = computed(() => resolveEncryptedMediaKind(props.attachment.mimeType)?.kind ?? 'video');
const sizeLabel = computed(() => formatMediaByteSize(props.attachment.size));

function stopObservingViewport(): void {
  viewportObserver?.disconnect();
  viewportObserver = null;
}

function loadMedia(): void {
  stopObservingViewport();
  void loader.load(props.attachment);
}

watch(
  [rootRef, () => props.autoLoad === true],
  ([element, autoLoad]) => {
    stopObservingViewport();
    if (!element || !autoLoad || loadState.value.status !== 'idle') {
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      loadMedia();
      return;
    }

    viewportObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMedia();
        }
      },
      { rootMargin: AUTO_LOAD_ROOT_MARGIN }
    );
    viewportObserver.observe(element);
  },
  { flush: 'post' }
);

function handlePlayRequest(): void {
  shouldPlayWhenReady = true;
  loadMedia();
}

// A tap on the placeholder means "play"; start playback once the decrypted media is mounted.
// Browsers may still refuse when the decryption outlived the user gesture, which leaves the
// native controls ready for a second tap.
watch(playerRef, (player) => {
  if (!player || !shouldPlayWhenReady) {
    return;
  }

  shouldPlayWhenReady = false;
  void nextTick(() => player.play().catch(() => undefined));
});

onBeforeUnmount(() => {
  stopObservingViewport();
  loader.dispose();
});
</script>

<style scoped>
.attachment-media {
  width: 320px;
  max-width: 100%;
}

.attachment-media__player {
  display: block;
  width: 100%;
  border-radius: 8px;
}

video.attachment-media__player {
  max-height: 360px;
  background: #000;
}

.attachment-media__placeholder {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px 8px 8px;
  background: rgba(127, 127, 127, 0.12);
  border-radius: 8px;
}

.attachment-media__placeholder--video {
  position: relative;
  flex-direction: column;
  justify-content: center;
  aspect-ratio: 16 / 9;
  padding: 12px;
  color: #fff;
  background: rgba(0, 0, 0, 0.82);
}

.attachment-media__placeholder--video .attachment-media__details {
  position: absolute;
  right: 12px;
  bottom: 8px;
  left: 12px;
  flex: none;
}

.attachment-media__action {
  flex: none;
}

.attachment-media__details {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}

.attachment-media__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-media__caption {
  font-size: 0.75rem;
  opacity: 0.75;
}
</style>
