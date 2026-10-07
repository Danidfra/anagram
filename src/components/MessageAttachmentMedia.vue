<template>
  <div class="attachment-media" :data-kind="kind" data-testid="message-encrypted-media">
    <video
      v-if="mediaSrc && kind === 'video'"
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
      class="attachment-media__player"
      data-testid="message-encrypted-audio"
      controls
      preload="metadata"
      :src="mediaSrc"
      :aria-label="label"
    />
    <div v-else class="attachment-media__placeholder" data-testid="message-encrypted-media-placeholder">
      <q-icon :name="kind === 'video' ? 'videocam' : 'audiotrack'" size="22px" aria-hidden="true" />
      <div class="attachment-media__details">
        <span class="attachment-media__label">{{ label }}</span>
        <span v-if="hasFailed" class="text-negative" data-testid="message-encrypted-media-failed">
          {{ $t('message.encryptedMedia.failed') }}
        </span>
        <span v-else class="text-caption">
          <q-icon name="lock" size="14px" aria-hidden="true" />
          {{ $t('message.encryptedMedia.encrypted') }}
        </span>
      </div>
      <q-spinner v-if="isLoading" size="18px" data-testid="message-encrypted-media-loading" />
      <q-btn
        v-else
        flat
        dense
        no-caps
        color="primary"
        data-testid="message-encrypted-media-load"
        :label="hasFailed ? $t('message.encryptedMedia.retry') : $t('message.encryptedMedia.load')"
        @click.stop="loadMedia"
      />
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
import { resolveEncryptedMediaKind } from 'src/utils/encryptedMedia';
import { computed, onBeforeUnmount, ref } from 'vue';

const props = defineProps<{
  attachment: MessageAttachmentMetadata;
  label: string;
}>();

// Unlike images, video and audio are never downloaded or decrypted until the user asks.
const loadState = ref<EncryptedMediaLoadState>({ status: 'idle', objectUrl: '' });
const loader = createEncryptedMediaLoader(encryptedMediaService, (state) => {
  loadState.value = state;
});

const mediaSrc = computed(() => loadState.value.objectUrl);
const isLoading = computed(() => loadState.value.status === 'loading');
const hasFailed = computed(() => loadState.value.status === 'failed');
const kind = computed(() => resolveEncryptedMediaKind(props.attachment.mimeType)?.kind ?? 'video');

function loadMedia(): void {
  void loader.load(props.attachment);
}

onBeforeUnmount(() => {
  loader.dispose();
});
</script>

<style scoped>
.attachment-media {
  max-width: min(100%, 360px);
}

.attachment-media__player {
  display: block;
  width: 100%;
  max-height: 360px;
  border-radius: 8px;
}

.attachment-media__placeholder {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 220px;
  padding: 10px 12px;
  background: rgba(127, 127, 127, 0.12);
  border-radius: 8px;
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
</style>
