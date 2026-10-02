<template>
  <img v-if="resolvedSrc" v-bind="$attrs" :src="resolvedSrc" :alt="alt" />
  <div
    v-else
    class="attachment-image__placeholder"
    :class="$attrs.class"
    role="img"
    :aria-label="alt"
    :data-testid="hasFailed ? 'message-image-unavailable' : 'message-image-decrypting'"
  >
    <q-icon v-if="hasFailed" name="broken_image" size="20px" />
    <q-spinner v-else size="18px" />
  </div>
</template>

<script setup lang="ts">
import { encryptedMediaService } from 'src/services/encryptedMediaService';
import type { MessageAttachmentMetadata } from 'src/types/chat';
import { isEncryptedAttachment } from 'src/utils/messageAttachments';
import { computed, onBeforeUnmount, ref, watch } from 'vue';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
  attachment?: MessageAttachmentMetadata | null;
  src?: string;
  alt: string;
}>();

const decryptedSrc = ref('');
const hasFailed = ref(false);
let acquiredAttachment: MessageAttachmentMetadata | null = null;
let loadGeneration = 0;

const isEncrypted = computed(() =>
  props.attachment ? isEncryptedAttachment(props.attachment) : false
);
// Encrypted attachments only ever render from the decrypted object URL; the ciphertext URL is
// never used as an image source.
const resolvedSrc = computed(() => {
  if (isEncrypted.value) {
    return decryptedSrc.value;
  }

  return (props.attachment?.url ?? props.src ?? '').trim();
});

function releaseAcquiredAttachment(): void {
  if (acquiredAttachment) {
    encryptedMediaService.releaseDecryptedObjectUrl(acquiredAttachment);
    acquiredAttachment = null;
  }
  decryptedSrc.value = '';
}

watch(
  () => {
    const attachment = props.attachment;
    if (!attachment?.encryption) {
      return '';
    }

    return [
      attachment.url,
      attachment.sha256 ?? '',
      attachment.mimeType,
      attachment.encryption.key,
      attachment.encryption.nonce,
    ].join('|');
  },
  async (identity) => {
    loadGeneration += 1;
    const generation = loadGeneration;
    releaseAcquiredAttachment();
    hasFailed.value = false;

    const attachment = props.attachment;
    if (!identity || !attachment || !isEncryptedAttachment(attachment)) {
      return;
    }

    const snapshot: MessageAttachmentMetadata = {
      ...attachment,
      encryption: { ...attachment.encryption },
    };
    acquiredAttachment = snapshot;
    try {
      const objectUrl = await encryptedMediaService.acquireDecryptedObjectUrl(snapshot);
      if (generation === loadGeneration) {
        decryptedSrc.value = objectUrl;
      }
    } catch {
      if (acquiredAttachment === snapshot) {
        // A failed load is not cached, so there is no reference left to release.
        acquiredAttachment = null;
      }
      if (generation === loadGeneration) {
        hasFailed.value = true;
      }
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  loadGeneration += 1;
  releaseAcquiredAttachment();
});
</script>

<style scoped>
.attachment-image__placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 96px;
  min-height: 72px;
  color: var(--q-primary, currentColor);
  background: rgba(127, 127, 127, 0.12);
  border-radius: 8px;
}
</style>
