<script lang="ts">
  import { onMount } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { useRelayStore } from '#src/stores/relayStore.ts';
  import { useNip65RelayStore } from '#src/stores/nip65RelayStore.ts';
  import { observe } from '#src/lib/state/store.ts';
  import { normalizeRelayUrl } from '#src/lib/nostr/client.ts';
  import { DEFAULT_RELAYS } from '#src/constants/relays.ts';
  import type { RelayListEntry } from '#src/stores/relayListStoreFactory.ts';
  import RelayInfo from './RelayInfo.svelte';
  import Icon from '../Icon.svelte';
  import IrohSettings from './IrohSettings.svelte';
  const nostr = useNostrStore(),
    app = useRelayStore(),
    mine = useNip65RelayStore();
  app.init();
  mine.init();
  const state = observe(() => ({
    mine: mine.relayEntries,
    app: app.relayEntries,
    version: nostr.relayStatusVersion,
  }));
  let tab = 'my',
    input = '',
    error = '',
    syncError = '',
    syncing = false;
  let pending: RelayListEntry[] | null = null;
  let infos: Record<string, unknown> = {},
    loading: Record<string, boolean> = {};
  $: entries = tab === 'my' ? $state.mine : $state.app;
  $: store = tab === 'my' ? mine : app;
  async function sync() {
    pending = mine.relayEntries.map((r) => ({ ...r }));
    if (syncing) return;
    syncing = true;
    syncError = '';
    try {
      while (pending) {
        const snapshot = pending;
        pending = null;
        await nostr.publishMyRelayList(snapshot, app.relays);
        await nostr.updateLoggedInUserRelayList(snapshot);
      }
    } catch {
      syncError = 'Your relay changes could not be published. Retry to sync them to your account.';
    } finally {
      syncing = false;
    }
  }
  function changed() {
    if (tab === 'my') void sync();
  }
  function add() {
    error = '';
    try {
      const parsed = new URL(input.trim());
      if (
        !['wss:', 'ws:'].includes(parsed.protocol) ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        parsed.hash
      )
        throw new Error();
      const url = normalizeRelayUrl(input.trim());
      if (entries.some((r) => normalizeRelayUrl(r.url) === url)) {
        error = $translate('relays.validation.alreadyAdded');
        return;
      }
      store.addRelay(url);
      input = '';
      changed();
    } catch {
      error = $translate('relays.relayMustValidWs');
    }
  }
  function restore() {
    store.restoreDefaults();
    if (tab === 'my') {
      for (const url of DEFAULT_RELAYS) mine.addRelay(url);
      void sync();
    }
  }
  async function info(url: string, force = false) {
    if (loading[url] || (!force && infos[url])) return;
    loading = { ...loading, [url]: true };
    try {
      infos = {
        ...infos,
        [url]: (await nostr.fetchRelayNip11Info(url, force)) ?? 'No NIP-11 information available.',
      };
    } catch {
      infos = { ...infos, [url]: 'Could not load NIP-11 information.' };
    } finally {
      loading = { ...loading, [url]: false };
    }
  }
  onMount(() => {
    void nostr.ensureRelayConnections([...mine.relays, ...app.relays]).catch(() => {});
  });
</script>

<div class="settings-tabs" role="tablist" aria-label={$translate('relays.title')}>
  {#each [['my', 'relays.myRelays'], ['app', 'relays.appRelays.title'], ['iroh', 'iroh.title']] as [id, label]}<button
      role="tab"
      aria-selected={tab === id}
      data-testid={`settings-relays-${id}-tab`}
      onclick={() => {
        tab = id;
        input = '';
        error = '';
      }}>{$translate(label)}</button
    >{/each}
</div>
{#if tab === 'iroh'}<IrohSettings />{:else}
  <div class="settings-card" role="tabpanel" data-testid={`settings-relays-${tab}-panel`}>
    <form
      class="settings-actions"
      onsubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <label style="flex:1"
        >{$translate('relays.relayUrl')}<input
          data-testid="relay-editor-new-relay-input"
          bind:value={input}
          placeholder="wss://example-relay.io"
          spellcheck="false"
          autocapitalize="none"
        /></label
      ><button
        class="icon-button"
        data-testid="relay-editor-add-relay-button"
        aria-label={$translate('relays.addRelay')}
        disabled={!input.trim()}><Icon name="add" /></button
      >
    </form>
    <div>
      <button class="outline" onclick={restore}>{$translate('relays.restoreDefaultRelays')}</button>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if tab === 'my' && syncing}<p role="status">{$translate('common.progress')}</p>{/if}
    {#if syncError}<p class="error" role="alert">{syncError}</p>
      <button class="outline" onclick={sync} disabled={syncing}>{$translate('common.retry')}</button
      >{/if}
    {#each entries as relay, index (relay.url)}
      <div class="settings-relay">
        <div class="settings-relay-head">
          <span
            class="connection-dot"
            class:connected={$state.version >= 0 &&
              nostr.getRelayConnectionState(relay.url) === 'connected'}
          ></span><span class="relay-url">{relay.url}</span><label
            ><input
              type="checkbox"
              checked={relay.read}
              onchange={(e) => {
                store.setRelayFlags(index, { read: e.currentTarget.checked });
                changed();
              }}
            />{$translate('relays.read')}</label
          ><label
            ><input
              type="checkbox"
              checked={relay.write}
              onchange={(e) => {
                store.setRelayFlags(index, { write: e.currentTarget.checked });
                changed();
              }}
            />{$translate('common.write')}</label
          ><button
            class="icon-button"
            aria-label={$translate('relays.deleteRelay')}
            onclick={() => {
              store.removeRelay(index);
              changed();
            }}><Icon name="close" /></button
          >
        </div>
        <details
          ontoggle={(e) => {
            if (e.currentTarget.open) void info(relay.url);
          }}
        >
          <summary>{$translate('relays.expandLoadNip11Data')}</summary>{#if loading[relay.url]}<p>
              {$translate('relays.loadingNip11Data')}
            </p>{:else}{#if typeof infos[relay.url] === 'string'}<p>
                {String(infos[relay.url])}
              </p>{:else}<RelayInfo value={infos[relay.url]} />{/if}
            <button class="link" onclick={() => info(relay.url, true)}
              >{$translate('common.refresh')}</button
            >{/if}
        </details>
      </div>
    {:else}<p>
        {$translate(tab === 'my' ? 'relays.nip65RelaysConfigured' : 'relays.appRelaysConfigured')}
      </p>{/each}
  </div>{/if}
