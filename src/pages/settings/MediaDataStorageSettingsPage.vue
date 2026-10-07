<template>
  <SettingsDetailLayout :title="$t('mediaDataStorage.title')" icon="storage">
    <q-card flat bordered class="media-data-card">
      <q-card-section class="media-data-card__section">
        <div>
          <div class="text-body1">{{ $t('mediaDataStorage.privateMediaServer') }}</div>
          <div class="text-caption text-grey-6">
            {{ $t('mediaDataStorage.privateMediaServerDescription') }}
          </div>
        </div>

        <q-form class="media-data-card__form" @submit.prevent="privateField.save">
          <q-input
            v-model="privateField.input.value"
            outlined
            type="url"
            inputmode="url"
            autocomplete="url"
            autocapitalize="none"
            spellcheck="false"
            class="nc-input"
            data-testid="settings-private-media-input"
            :label="$t('mediaDataStorage.serverUrl')"
            :hint="$t('mediaDataStorage.serverUrlHint')"
            :error="Boolean(privateField.validationError.value)"
            :error-message="privateField.validationError.value"
            :disable="privateField.isSaving.value"
          />

          <div class="text-caption text-grey-6">{{ $t('mediaDataStorage.testServerHint') }}</div>

          <div class="media-data-card__actions">
            <q-btn
              flat
              no-caps
              icon="verified"
              data-testid="settings-private-media-test"
              :label="$t('mediaDataStorage.testServer')"
              :loading="isTestingPrivateServer"
              :disable="isTestingPrivateServer || privateField.isSaving.value || !privateField.normalizedUrl.value"
              @click="testPrivateServer"
            />
            <q-btn
              flat
              no-caps
              icon="restart_alt"
              data-testid="settings-private-media-restore-default"
              :label="$t('mediaDataStorage.restoreDefault')"
              :disable="privateField.isSaving.value || !privateField.canRestoreDefault.value"
              @click="privateField.restoreDefault"
            />
            <q-btn
              unelevated
              no-caps
              color="primary"
              type="submit"
              data-testid="settings-private-media-save"
              :label="$t('common.save')"
              :loading="privateField.isSaving.value"
              :disable="!privateField.canSave.value"
            />
          </div>
        </q-form>

        <q-toggle
          :model-value="showPrivateMediaNotice"
          data-testid="settings-private-media-notice-toggle"
          :label="$t('mediaDataStorage.showPrivateMediaNotice')"
          @update:model-value="handlePrivateMediaNoticeToggle"
        />
      </q-card-section>
    </q-card>

    <q-card flat bordered class="media-data-card">
      <q-card-section class="media-data-card__section">
        <div>
          <div class="text-body1">{{ $t('mediaDataStorage.blossomServer') }}</div>
          <div class="text-caption text-grey-6">
            {{ $t('mediaDataStorage.blossomServerDescription') }}
          </div>
        </div>

        <q-form class="media-data-card__form" @submit.prevent="regularField.save">
          <q-input
            v-model="regularField.input.value"
            outlined
            type="url"
            inputmode="url"
            autocomplete="url"
            autocapitalize="none"
            spellcheck="false"
            class="nc-input"
            data-testid="settings-blossom-server-input"
            :label="$t('mediaDataStorage.serverUrl')"
            :hint="$t('mediaDataStorage.serverUrlHint')"
            :error="Boolean(regularField.validationError.value)"
            :error-message="regularField.validationError.value"
            :disable="regularField.isSaving.value"
          />

          <div class="media-data-card__actions">
            <q-btn
              flat
              no-caps
              icon="restart_alt"
              data-testid="settings-blossom-restore-default"
              :label="$t('mediaDataStorage.restoreDefault')"
              :disable="regularField.isSaving.value || !regularField.canRestoreDefault.value"
              @click="regularField.restoreDefault"
            />
            <q-btn
              unelevated
              no-caps
              color="primary"
              type="submit"
              data-testid="settings-blossom-save"
              :label="$t('common.save')"
              :loading="regularField.isSaving.value"
              :disable="!regularField.canSave.value"
            />
          </div>
        </q-form>

        <div class="media-data-card__privacy text-caption text-grey-6">
          <q-icon name="encrypted" size="18px" aria-hidden="true" />
          <span>{{ $t('mediaDataStorage.encryptedPreference') }}</span>
        </div>
      </q-card-section>
    </q-card>
  </SettingsDetailLayout>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuasar } from 'quasar';
import SettingsDetailLayout from 'src/components/SettingsDetailLayout.vue';
import { t } from 'src/i18n';
import { verifyPrivateMediaServer } from 'src/services/blossomUploadService';
import { useNostrStore } from 'src/stores/nostrStore';
import {
  DEFAULT_BLOSSOM_SERVER_URL,
  DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL,
  getBlossomServerHost,
  normalizeBlossomServerUrl,
} from 'src/utils/blossomServer';
import {
  isPrivateMediaNoticeDismissed,
  setPrivateMediaNoticeDismissed,
} from 'src/utils/privateMediaNoticePreference';
import { reportUiError } from 'src/utils/uiErrorHandler';

const $q = useQuasar();
const nostrStore = useNostrStore();

interface ServerFieldConfig {
  defaultUrl: string;
  initialUrl: string;
  save: (serverUrl: string) => Promise<string>;
  savedMessageKey: string;
  saveFailedMessageKey: string;
  saveFailedLogMessage: string;
}

function useServerField(config: ServerFieldConfig) {
  const savedUrl = ref(config.initialUrl);
  const input = ref(config.initialUrl);
  const isSaving = ref(false);
  const normalizedUrl = computed(() => normalizeBlossomServerUrl(input.value));
  const validationError = computed(() => {
    if (!input.value.trim()) {
      return t('mediaDataStorage.serverUrlRequired');
    }

    return normalizedUrl.value ? '' : t('mediaDataStorage.serverUrlInvalid');
  });
  const canSave = computed(
    () => !isSaving.value && Boolean(normalizedUrl.value) && normalizedUrl.value !== savedUrl.value
  );
  const canRestoreDefault = computed(
    () => input.value.trim() !== config.defaultUrl || savedUrl.value !== config.defaultUrl
  );

  async function persist(serverUrl: string): Promise<void> {
    if (isSaving.value) {
      return;
    }

    isSaving.value = true;
    try {
      const nextUrl = await config.save(serverUrl);
      savedUrl.value = nextUrl;
      input.value = nextUrl;
      $q.notify({ type: 'positive', message: t(config.savedMessageKey), position: 'top' });
    } catch (error) {
      reportUiError(config.saveFailedLogMessage, error, t(config.saveFailedMessageKey));
    } finally {
      isSaving.value = false;
    }
  }

  function save(): void {
    if (canSave.value && normalizedUrl.value) {
      void persist(normalizedUrl.value);
    }
  }

  function restoreDefault(): void {
    if (canRestoreDefault.value) {
      void persist(config.defaultUrl);
    }
  }

  return {
    input,
    isSaving,
    normalizedUrl,
    validationError,
    canSave,
    canRestoreDefault,
    save,
    restoreDefault,
  };
}

const regularField = useServerField({
  defaultUrl: DEFAULT_BLOSSOM_SERVER_URL,
  initialUrl: nostrStore.getBlossomServerUrl(),
  save: (serverUrl) => nostrStore.saveBlossomServerUrl(serverUrl),
  savedMessageKey: 'mediaDataStorage.serverSaved',
  saveFailedMessageKey: 'mediaDataStorage.serverSaveFailed',
  saveFailedLogMessage: 'Failed to save Blossom server preference',
});

const privateField = useServerField({
  defaultUrl: DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL,
  initialUrl: nostrStore.getPrivateMediaBlossomServerUrl(),
  save: (serverUrl) => nostrStore.savePrivateMediaBlossomServerUrl(serverUrl),
  savedMessageKey: 'mediaDataStorage.privateMediaServerSaved',
  saveFailedMessageKey: 'mediaDataStorage.privateMediaServerSaveFailed',
  saveFailedLogMessage: 'Failed to save private media Blossom server preference',
});

const isTestingPrivateServer = ref(false);

// Same preference as the upload notice's "Don't show this again". It only controls that
// informational notice; private media is always encrypted either way.
const showPrivateMediaNotice = ref(!isPrivateMediaNoticeDismissed());

function handlePrivateMediaNoticeToggle(value: boolean): void {
  setPrivateMediaNoticeDismissed(!value);
  showPrivateMediaNotice.value = !isPrivateMediaNoticeDismissed();
}

// Tests whichever URL is in the field, so a server can be verified before it is saved.
async function testPrivateServer(): Promise<void> {
  const serverUrl = privateField.normalizedUrl.value;
  if (!serverUrl || isTestingPrivateServer.value) {
    return;
  }

  isTestingPrivateServer.value = true;
  try {
    await nostrStore.ensureBlossomUploadAuthentication();
    const { cleanedUp } = await verifyPrivateMediaServer({
      serverUrl,
      signUploadAuthHeader: nostrStore.signBlossomUploadAuthHeader,
    });
    $q.notify({
      type: cleanedUp ? 'positive' : 'warning',
      message: t(
        cleanedUp
          ? 'mediaDataStorage.testServerPassed'
          : 'mediaDataStorage.testServerPassedNoCleanup',
        { server: getBlossomServerHost(serverUrl) }
      ),
      position: 'top',
    });
  } catch (error) {
    reportUiError(
      'Private media Blossom server check failed',
      error,
      t('mediaDataStorage.testServerFailed')
    );
  } finally {
    isTestingPrivateServer.value = false;
  }
}
</script>

<style scoped>
.media-data-card {
  width: 100%;
  max-width: none;
  background: color-mix(in srgb, var(--nc-sidebar) 92%, transparent);
}

.media-data-card__section {
  display: grid;
  gap: 20px;
}

.media-data-card__form {
  display: grid;
  gap: 18px;
  max-width: 720px;
}

.media-data-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.media-data-card__privacy {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 720px;
}

.media-data-card__privacy .q-icon {
  flex: 0 0 auto;
  margin-top: 1px;
}

@media (--nc-mobile-viewport) {
  .media-data-card__actions {
    align-items: stretch;
    flex-direction: column-reverse;
  }
}
</style>
