<script lang="ts">
  import { onMount } from 'svelte';
  import { locale, languageOptions, setLocale, translate } from '#src/i18n.ts';
  import {
    readDarkModePreference,
    saveDarkModePreference,
    readDesktopMessageLayoutPreference,
    saveDesktopMessageLayoutPreference,
  } from '#src/utils/themeStorage.ts';
  import {
    DEFAULT_BLOSSOM_SERVER_URL,
    normalizeBlossomServerUrl,
  } from '#src/utils/blossomServer.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { observe } from '#src/lib/state/store.ts';
  import Icon from '../Icon.svelte';
  export let section: string;
  const nostr = useNostrStore();
  const startup = observe(() => nostr.isRestoringStartupState);
  let dark = readDarkModePreference() ?? document.body.classList.contains('body--dark');
  let layout = readDesktopMessageLayoutPreference();
  let saved = nostr.getBlossomServerUrl(),
    server = saved,
    busy = false,
    error = '',
    notice = '';
  $: normalized = normalizeBlossomServerUrl(server);
  $: if (!$startup && !busy && server === saved) {
    saved = nostr.getBlossomServerUrl();
    server = saved;
  }
  async function persist(value: string) {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      saved = await nostr.saveBlossomServerUrl(value);
      server = saved;
      notice = $translate('mediaDataStorage.serverSaved');
    } catch {
      error = $translate('mediaDataStorage.serverSaveFailed');
    } finally {
      busy = false;
    }
  }
  function sync() {
    if (!busy && server === saved) {
      saved = nostr.getBlossomServerUrl();
      server = saved;
    }
  }
  onMount(() => {
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  });
</script>

{#if section === 'theme'}
  <div class="settings-card theme-card">
    <div class="theme-setting">
      <div>
        <h3>{$translate('settings.appearance')}</h3>
        <small>{$translate('settings.theme.description')}</small>
      </div>
      <label class="settings-switch"
        ><span>{$translate('common.darkMode')}</span><input
          type="checkbox"
          role="switch"
          aria-label={$translate('common.darkMode')}
          checked={dark}
          onchange={(e) => {
            dark = e.currentTarget.checked;
            saveDarkModePreference(dark);
            localStorage.setItem('anagram-theme', dark ? 'dark' : 'light');
            document.body.classList.toggle('body--dark', dark);
          }}
        /></label
      >
    </div>
    <hr />
    <div>
      <h3>{$translate('settings.desktopMessageLayout.title')}</h3>
      <small>{$translate('settings.desktopMessageLayout.description')}</small>
    </div>
    <label class="settings-select-field"
      ><span>{$translate('settings.desktopMessageLayout.title')}</span><select
        aria-label={$translate('settings.desktopMessageLayout.title')}
        data-testid="settings-desktop-message-layout-toggle"
        bind:value={layout}
        onchange={() => saveDesktopMessageLayoutPreference(layout)}
        >{#each ['text', 'bubbles'] as option}<option value={option}
            >{$translate(`settings.desktopMessageLayout.${option}`)}</option
          >{/each}</select
      ></label
    >
  </div>
{:else if section === 'language'}
  <div class="settings-card language-card">
    <div>
      <h3>{$translate('settings.language.field')}</h3>
      <small>{$translate('settings.language.description')}</small>
    </div>
    <label class="settings-select-field"
      ><span>{$translate('settings.language.title')}</span><select
        aria-label={$translate('settings.language.title')}
        value={$locale}
        onchange={(e) => setLocale(e.currentTarget.value as typeof $locale)}
        >{#each languageOptions as language}<option value={language.code}
            >{language.nativeName === language.englishName
              ? language.nativeName
              : `${language.nativeName} - ${language.englishName}`}
          </option>{/each}</select
      ></label
    >
  </div>
{:else}
  <div class="settings-card">
    <div>
      <h3>{$translate('mediaDataStorage.blossomServer')}</h3>
      <small>{$translate('mediaDataStorage.blossomServerDescription')}</small>
    </div>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        if (normalized && normalized !== saved) void persist(normalized);
      }}
    >
      <label
        >{$translate('mediaDataStorage.serverUrl')}<input
          data-testid="settings-blossom-server-input"
          type="url"
          bind:value={server}
          disabled={busy || $startup}
          spellcheck="false"
          autocapitalize="none"
        /><small>{$translate('mediaDataStorage.serverUrlHint')}</small></label
      >
      {#if !normalized}<p class="error">
          {$translate(
            server.trim()
              ? 'mediaDataStorage.serverUrlInvalid'
              : 'mediaDataStorage.serverUrlRequired',
          )}
        </p>{/if}
      <div class="settings-actions end">
        <button
          type="button"
          class="outline"
          data-testid="settings-blossom-restore-default"
          disabled={busy ||
            $startup ||
            (server === DEFAULT_BLOSSOM_SERVER_URL && saved === DEFAULT_BLOSSOM_SERVER_URL)}
          onclick={() => persist(DEFAULT_BLOSSOM_SERVER_URL)}
          >{$translate('mediaDataStorage.restoreDefault')}</button
        ><button
          class="primary"
          data-testid="settings-blossom-save"
          disabled={busy || $startup || !normalized || normalized === saved}
          >{$translate('common.save')}</button
        >
      </div>
    </form>
    <div class="settings-actions settings-caption">
      <Icon name="lock" />{$translate('mediaDataStorage.encryptedPreference')}
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}{#if notice}<p role="status">
        {notice}
      </p>{/if}
  </div>
{/if}
