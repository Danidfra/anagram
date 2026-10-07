<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { roomPolicy, publicGroupShareLink } from '#src/stores/nostr/publicGroups.ts';
  import ProfileName from '../ProfileName.svelte';
  import MessageRelayStatus from '../MessageRelayStatus.svelte';
  import { publicMessageForDisplay } from '#src/utils/publicMessage.ts';
  import { uploadBlossomMedia } from '#src/services/blossomUploadService.ts';
  import { threadHistoryPull } from '#src/lib/actions/threadHistoryPull.ts';
  import { autosizeTextarea } from '#src/lib/actions/autosizeTextarea.ts';
  import PublicGroupDialog from './PublicGroupDialog.svelte';
  import PublicMessage from './PublicMessage.svelte';
  import PublicAvatar from './PublicAvatar.svelte';
  import Avatar from '../Avatar.svelte';
  import Icon from '../Icon.svelte';
  export let link: string;
  export let onauthor: (publicKey: string) => void;
  const nostr = useNostrStore(),
    runtime = nostr.publicGroups,
    state = runtime.state;
  let details = false,
    draft = '',
    sending = false,
    error = '',
    notice = '',
    nearBottom = true;
  let paging = false;
  let log: HTMLDivElement;
  let fileInput: HTMLInputElement;
  let uploadController: AbortController | undefined;
  let pendingFile: File | undefined;
  async function upload() {
    if (
      !pendingFile ||
      !room ||
      sending ||
      $state.stale ||
      $state.history ||
      roomPolicy(room, own) !== 'trusted'
    )
      return;
    const target = room.address;
    sending = true;
    error = '';
    uploadController = new AbortController();
    try {
      const result = await uploadBlossomMedia(pendingFile, {
        serverUrl: nostr.getBlossomServerUrl(),
        signal: uploadController.signal,
        signUploadAuthHeader: nostr.signBlossomUploadAuthHeader,
      });
      if (uploadController.signal.aborted || room?.address !== target) return;
      await runtime.send(result.attachment.url, result.attachment);
      pendingFile = undefined;
      nearBottom = true;
    } catch (cause) {
      if (!uploadController.signal.aborted) error = (cause as Error).message;
    } finally {
      sending = false;
      if (fileInput) fileInput.value = '';
    }
  }
  $: room = $state.room;
  $: own = nostr.getLoggedInPublicKeyHex() || '';
  $: visible = room ? $state.messages.filter((e) => roomPolicy(room!, e.pubkey) !== 'blocked') : [];
  function scrollToEnd() {
    if (log) log.scrollTop = log.scrollHeight;
  }
  $: if (visible.length && nearBottom && !paging) void tick().then(scrollToEnd);
  async function pageHistory(older = true) {
    if (paging || $state.loading) return;
    if (older ? !$state.more : !$state.hasNewer) return;
    paging = true;
    nearBottom = false;
    const rows = [...log.querySelectorAll<HTMLElement>('[data-event-id]')];
    const anchor = rows.find(
      (row) => row.getBoundingClientRect().bottom > log.getBoundingClientRect().top,
    );
    const offset = anchor?.getBoundingClientRect().top;
    try {
      await (older ? runtime.older() : runtime.newer());
      await tick();
      const retained =
        anchor && log.querySelector<HTMLElement>(`[data-event-id="${anchor.dataset.eventId}"]`);
      if (retained && offset !== undefined)
        log.scrollTop += retained.getBoundingClientRect().top - offset;
    } finally {
      paging = false;
    }
  }
  async function send() {
    if (sending) return;
    sending = true;
    error = '';
    try {
      if (nostr.containsSessionSecret(draft))
        throw new Error('This message contains your session secret.');
      await runtime.send(draft);
      draft = '';
      nearBottom = true;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      sending = false;
    }
  }
  async function share() {
    try {
      await navigator.clipboard.writeText(publicGroupShareLink(room!));
      notice = 'Group link copied';
    } catch {
      error = 'Could not copy the group link.';
    }
  }
  onMount(() => {
    void runtime.open(link);
    const reconnect = () => {
      if (document.visibilityState === 'visible' && $state.stale && !$state.refreshing)
        void runtime.open(link);
    };
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    return () => {
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
      uploadController?.abort();
      runtime.stopView();
    };
  });
</script>

{#if room}
  <header class="thread-header">
    <button
      class="icon-button mobile-back"
      aria-label="Back to chats"
      onclick={() => goto('/chats')}><Icon name="back" /></button
    >
    <button class="identity" onclick={() => (details = true)} aria-label="Public group settings"
      ><PublicAvatar name={room.name} picture={room.picture} /><span
        ><strong>{room.name}</strong><small>Public group</small></span
      ></button
    >
    <button class="icon-button" aria-label="Copy public group link" onclick={share}
      ><Icon name="content_copy" /></button
    >
    <button class="icon-button" aria-label="Refresh public group" onclick={() => runtime.open(link)}
      ><Icon name="refresh" /></button
    >
  </header>
  {#if $state.ancestors.length}<label class="history"
      >Ownership transferred · History <select
        value={$state.history}
        disabled={$state.loading || sending}
        onchange={(e) => runtime.history(e.currentTarget.value)}
        ><option value="">Current group</option>{#each $state.ancestors as previous}<option
            value={previous.address}>{previous.name} · {previous.owner.slice(0, 8)}</option
          >{/each}</select
      ></label
    >{/if}
  <div
    class="public-log"
    use:threadHistoryPull={{
      chatId: room.address + $state.history,
      canLoad: () => $state.more && !paging,
      loading: () => paging,
      load: () => void pageHistory(),
    }}
    bind:this={log}
    role="log"
    aria-label="Public group messages"
    onscroll={() => {
      if (paging) return;
      nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      if (nearBottom && $state.hasNewer) void pageHistory(false);
    }}
  >
    {#if paging}<div class="history-loading" role="status">Loading messages…</div>{/if}
    {#each visible as event (event.id)}
      <article
        class:own={event.pubkey === own}
        data-testid="public-message"
        data-event-id={event.id}
      >
        <button
          class="author-avatar"
          data-testid="thread-author-profile-link"
          aria-label="Open direct message"
          onclick={() => onauthor(event.pubkey)}
          ><Avatar
            publicKey={event.pubkey === own || roomPolicy(room, event.pubkey) === 'trusted'
              ? event.pubkey
              : ''}
            name={event.pubkey.slice(0, 8)}
            size={32}
          /></button
        >
        <div class="message">
          <button
            class="bubble-author-name"
            data-testid="thread-author-name-link"
            style:color={`var(--bubble-author-${(Number.parseInt(event.pubkey.slice(0, 8), 16) || 0) % 6})`}
            onclick={() => onauthor(event.pubkey)}
            >{#if event.pubkey === own}You{:else}<ProfileName
                publicKey={event.pubkey}
                fallback={event.pubkey === room.owner ? 'Owner' : event.pubkey.slice(0, 12)}
              />{/if}</button
          ><PublicMessage
            {event}
            trusted={roomPolicy(room, event.pubkey) === 'trusted'}
            oncontact={onauthor}
          /><time datetime={new Date(event.created_at * 1000).toISOString()}
            >{new Date(event.created_at * 1000).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}<MessageRelayStatus
              message={publicMessageForDisplay(event, own)}
              contactName={room.name}
              contactRelayUrls={($state.ancestors.find((r) => r.address === $state.history) ?? room)
                .relays}
              publicGroup
              onretry={(url) => runtime.retryMessage(event.id!, url)}
            /></time
          >
        </div>
      </article>
    {:else}<p class="empty">
        {$state.refreshing || $state.loading
          ? 'Loading public messages…'
          : $state.stale
            ? 'Saved messages will appear here while reconnecting.'
            : 'No messages to show. Say hello.'}
      </p>{/each}
  </div>
  {#if $state.refreshing}<p class="status" role="status">
      Syncing public group…
    </p>{:else if $state.stale}<p class="status">Offline · Showing saved messages.</p>{/if}
  {#if notice}<p class="status" role="status">{notice}</p>{/if}
  {#if error || $state.error}<p class="status error" role="alert">{error || $state.error}</p>{/if}
  {#if pendingFile}<div class="status">
      <p>Upload {pendingFile.name}? This file and its link will be public.</p>
      <button class="outline" disabled={sending} onclick={() => (pendingFile = undefined)}
        >Cancel</button
      ><button class="primary" disabled={sending} onclick={upload}
        >{sending ? 'Uploading…' : 'Upload and send'}</button
      >
    </div>{/if}
  <form
    class="public-composer"
    onsubmit={(e) => {
      e.preventDefault();
      void send();
    }}
  >
    <small
      >{$state.history
        ? 'Earlier group history is read-only.'
        : roomPolicy(room, own) === 'blocked'
          ? 'You are blocked in this group.'
          : 'Public: anyone can read these messages.'}</small
    >
    <div>
      {#if roomPolicy(room, own) === 'trusted' && !$state.history}<input
          hidden
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif,video/mp4,video/webm"
          bind:this={fileInput}
          onchange={(e) => (pendingFile = e.currentTarget.files?.[0])}
        /><button
          type="button"
          class="icon-button"
          aria-label="Attach public media"
          disabled={sending || $state.stale}
          onclick={() => fileInput.click()}><Icon name="attach" /></button
        >{/if}
      <textarea
        use:autosizeTextarea={draft}
        bind:value={draft}
        aria-label="Public message"
        placeholder="Write a public message"
        rows="1"
        maxlength="8000"
        disabled={$state.stale || !!$state.history || roomPolicy(room, own) === 'blocked'}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void send();
          }
        }}></textarea><button
        class="primary"
        disabled={sending ||
          !draft.trim() ||
          $state.stale ||
          !!$state.history ||
          roomPolicy(room, own) === 'blocked'}>Send</button
      >
    </div>
  </form>
{:else}
  <div class="unavailable">
    <button class="outline" onclick={() => goto('/chats')}>Back to chats</button>
    <p>
      {$state.refreshing ? 'Loading public group…' : $state.error || 'Public group unavailable.'}
    </p>
    {#if !$state.refreshing}<button class="primary" onclick={() => runtime.open(link)}>Retry</button
      >{/if}
  </div>
{/if}
{#if details && room}<PublicGroupDialog
    {room}
    onclose={() => (details = false)}
    onopen={() => {}}
    onleave={() => goto('/chats')}
  />{/if}

<style>
  .identity {
    display: flex;
    align-items: center;
    gap: 12px;
    text-align: left;
    flex: 1;
    min-width: 0;
  }
  .identity span {
    min-width: 0;
  }
  .identity strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .identity small,
  small,
  time {
    color: var(--nc-text-secondary);
  }
  .public-log {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overflow-anchor: none;
    padding: 18px;
  }
  .history-loading {
    position: sticky;
    top: 0;
    text-align: center;
    color: var(--nc-text-secondary);
    font-size: 12px;
  }
  article {
    display: flex;
    align-items: flex-end;
    gap: 10px;
    margin: 10px 0;
  }
  .message {
    max-width: min(720px, 85%);
    padding: 10px 14px;
    border-radius: 16px;
    background: var(--nc-received);
    min-width: 0;
  }
  .own .message {
    background: var(--nc-sent);
  }
  .author-avatar {
    display: flex;
    padding: 0;
    border-radius: 50%;
    flex-shrink: 0;
  }
  time {
    display: block;
    text-align: right;
    font-size: 11px;
    margin-top: 4px;
  }
  .empty {
    text-align: center;
    color: var(--nc-text-secondary);
  }
  .public-composer {
    padding: 10px 16px;
    background: var(--nc-panel-sidebar-bg);
    border-top: 1px solid var(--nc-border);
  }
  .public-composer div {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }
  .public-composer textarea {
    flex: 1;
    min-width: 0;
    max-height: 150px;
    resize: none;
  }
  .status,
  .history {
    padding: 8px 16px;
    margin: 0;
    font-size: 12px;
  }
  .history select {
    max-width: 60%;
    padding: 5px;
  }
  .unavailable {
    margin: auto;
    padding: 24px;
    text-align: center;
  }
  .mobile-back {
    display: none;
  }
  @media (max-width: 767px) {
    .mobile-back {
      display: inline-flex;
    }
    .thread-header {
      padding: 6px;
    }
    .public-log {
      padding: 10px;
    }
    .message {
      max-width: calc(100% - 42px);
    }
    .public-composer {
      padding: 8px;
    }
    .thread-header .icon-button {
      width: 32px;
    }
  }
</style>
