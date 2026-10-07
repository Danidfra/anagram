<script lang="ts">
  import { onDestroy } from 'svelte';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import {
    publicGroupShareLink,
    decodeRoomLink,
    type PublicRoom,
  } from '#src/stores/nostr/publicGroups.ts';
  import { previewUrl } from '#src/utils/linkPreview.ts';
  import { portal } from '#src/lib/actions/portal.ts';
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import GroupInviteDialog from '../GroupInviteDialog.svelte';
  import Avatar from '../Avatar.svelte';
  import Icon from '../Icon.svelte';
  import PublicAvatar from './PublicAvatar.svelte';
  export let room: PublicRoom | null = null;
  export let onleave: () => void = () => {};
  export let onclose: () => void;
  export let onopen: (link: string) => void;
  const nostr = useNostrStore();
  const runtime = nostr.publicGroups;
  let disposed = false;
  onDestroy(() => {
    disposed = true;
  });
  function close() {
    if (!disposed) onclose();
  }

  const reviewedId = room?.event.id;
  let name = room?.name || '',
    about = room?.about || '',
    picture = room?.picture || '';
  let tab = 'Profile',
    busy = false,
    error = '',
    notice = '',
    picker: '' | 'trusted' | 'blocked' = '';
  let join = '',
    predecessor = '',
    successor = '',
    confirmTransfer = false,
    confirmLeave = false;
  $: owner = !room || room.owner === nostr.getLoggedInPublicKeyHex();
  function show(node: HTMLDialogElement) {
    node.showModal();
    return { destroy: () => node.close() };
  }
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      await fn();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function save() {
    if (picture && !previewUrl(picture)) throw new Error('Use a public HTTPS picture URL.');
    if (room) {
      await runtime.update({ name, about, picture }, reviewedId!);
      close();
    } else {
      const link = await runtime.create({ name, about, picture, predecessor });
      close();
      onopen(link);
    }
  }
  async function members(keys: string[], remove = false) {
    if (!room || !picker) return;
    const existing = room[picker];
    const next = remove
      ? existing.filter((k) => !keys.includes(k))
      : [...new Set([...existing, ...keys])];
    await runtime.update({ [picker]: next }, reviewedId!);
    close();
  }
</script>

<dialog
  class="modal"
  use:portal
  use:show
  use:dismissOnBackdrop={() => {
    if (!busy) close();
  }}
  onclose={(event) => {
    if (event.currentTarget.isConnected) close();
  }}
  oncancel={(e) => {
    if (busy) e.preventDefault();
  }}
  aria-label={room ? 'Public group settings' : 'New public group'}
>
  <header>
    <h2>{room ? room.name : 'New public group'}</h2>
    <button
      class="icon-button"
      aria-label="Close public group dialog"
      disabled={busy}
      onclick={close}><Icon name="close" /></button
    >
  </header>
  {#if room}<div class="identity">
      <PublicAvatar name={room.name} picture={room.picture} size={48} />
      <div>
        <strong>{room.name}</strong><small
          >Public group · {owner ? 'You own this group' : 'Anyone can read and post'}</small
        >
      </div>
    </div>
    <div class="profile-actions">
      <button
        class="outline"
        disabled={busy}
        onclick={() =>
          act(async () => {
            await runtime.open(publicGroupShareLink(room!));
            close();
          })}>Refresh</button
      >
      <button
        class="outline"
        onclick={() =>
          act(async () => {
            await navigator.clipboard.writeText(publicGroupShareLink(room!));
            notice = 'Group link copied';
          })}>Copy group link</button
      >
    </div>
    <nav aria-label="Public group settings tabs">
      {#each ['Profile', 'Trusted', 'Blocked', ...(owner ? ['Ownership'] : [])] as item}<button
          class:active={tab === item}
          onclick={() => (tab = item)}>{item}</button
        >{/each}
    </nav>
  {/if}
  {#if tab === 'Profile'}
    {#if owner}<label>Group name<input bind:value={name} maxlength="100" /></label><label
        >Description<textarea bind:value={about} maxlength="2000" rows="3"></textarea></label
      ><label>Picture URL<input bind:value={picture} placeholder="https://…" /></label>
      {#if !room}<details>
          <summary>Continue a group from another owner</summary><label
            >Previous group link<input
              bind:value={predecessor}
              placeholder="Group link or naddr"
            /></label
          ><small>The current owner must then sign a transfer to your new group.</small>
        </details>{/if}
      <button class="primary" disabled={busy || !name.trim()} onclick={() => act(save)}
        >{busy ? 'Saving…' : room ? 'Save group profile' : 'Create public group'}</button
      >
    {:else}<p>{room?.about}</p>{/if}
    {#if room}<div class="leave-group">
        {#if confirmLeave}
          <p>Leave this public group? You can rejoin using its link.</p>
          <button class="outline" disabled={busy} onclick={() => (confirmLeave = false)}
            >Cancel</button
          >
          <button
            class="outline danger"
            disabled={busy}
            onclick={() =>
              act(async () => {
                await runtime.leave(room!.address);
                close();
                onleave();
              })}>Leave group</button
          >
        {:else}
          <button class="outline danger" disabled={busy} onclick={() => (confirmLeave = true)}
            >Leave public group</button
          >
        {/if}
      </div>{/if}
    {#if !room}<hr />
      <h3>Join an existing public group</h3>
      <label>Group link or naddr<input bind:value={join} /></label><button
        class="outline"
        disabled={!join.trim() || busy}
        onclick={() =>
          act(async () => {
            decodeRoomLink(join);
            close();
            onopen(join);
          })}>Join public group</button
      >{/if}
  {:else if tab === 'Trusted' || tab === 'Blocked'}
    {@const list = tab === 'Trusted' ? 'trusted' : 'blocked'}
    <p>
      {list === 'trusted'
        ? 'Trusted people can share links and media. The owner is always trusted.'
        : 'Messages from blocked people are hidden in this client. Public events remain on relays.'}
    </p>
    {#if owner}<button class="outline" disabled={busy} onclick={() => (picker = list)}
        >Add {list === 'trusted' ? 'trusted users' : 'blocked users'}</button
      >{/if}
    {#each room?.[list] || [] as key (key)}<div class="person">
        <Avatar name={key.slice(0, 8)} size={32} /><code>{nostr.encodeNpub(key)}</code
        >{#if owner}<button
            class="outline"
            disabled={busy}
            onclick={() => {
              picker = list;
              void act(() => members([key], true));
            }}>Remove</button
          >{/if}
      </div>{:else}<p class="hint">No users in this list.</p>{/each}
  {:else if tab === 'Ownership' && room && owner}
    <p>
      The new owner creates a public group with this group's link as its predecessor. Paste their
      new group link below.
    </p>
    <label>Successor group link<input bind:value={successor} /></label>
    <label class="confirm"
      ><input type="checkbox" bind:checked={confirmTransfer} />Transfer ownership. Their signed
      lists will govern the continuing group.</label
    >
    <button
      class="primary"
      disabled={busy || !successor || !confirmTransfer}
      onclick={() =>
        act(async () => {
          await runtime.update({ successor: decodeRoomLink(successor) }, reviewedId!);
          close();
        })}>Transfer ownership</button
    >
  {/if}
  {#if notice}<p role="status">{notice}</p>{/if}{#if error}<p class="error" role="alert">
      {error}
    </p>{/if}
</dialog>
{#if picker && !busy && room}<GroupInviteDialog
    title={picker === 'trusted' ? 'Add trusted users' : 'Add blocked users'}
    actionLabel="Add"
    showHistoryOption={false}
    existingKeys={[room.owner, ...room[picker]]}
    oninvite={(keys) => members(keys)}
    onclose={() => (picker = '')}
  />{/if}

<style>
  dialog {
    margin: auto;
    width: min(480px, calc(100vw - 24px));
    max-height: 90dvh;
    padding: 24px;
    border: 1px solid var(--nc-border);
    border-radius: 16px;
    background: var(--nc-menu-bg);
    box-shadow: var(--nc-shadow-md);
    color: var(--nc-text);
    overflow: auto;
  }
  dialog::backdrop {
    background: #0009;
  }
  header,
  .identity,
  .profile-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin: 16px 0;
  }
  .leave-group {
    border-top: 1px solid var(--nc-border);
    margin-top: 24px;
    padding-top: 16px;
  }
  .danger {
    color: var(--q-negative, #ef5350);
  }
  @media (max-width: 767px) {
    dialog {
      padding: 20px;
    }
  }
  .person {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  header {
    justify-content: space-between;
    margin-bottom: 16px;
  }
  h2 {
    margin: 0;
    font-size: 20px;
  }
  .identity {
    margin: 24px 0 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--nc-border);
  }
  small {
    display: block;
    color: var(--nc-text-secondary);
  }
  label {
    display: block;
    margin: 16px 0;
  }
  input,
  textarea {
    display: block;
    width: 100%;
    margin-top: 7px;
  }
  nav {
    display: flex;
    gap: 4px;
    overflow: auto;
    margin: 16px 0;
    border-bottom: 1px solid var(--nc-border);
  }
  nav button {
    flex: 1;
    padding: 10px 4px;
  }
  .active {
    color: var(--q-primary);
    border-bottom: 2px solid var(--q-primary);
  }
  .person {
    margin: 12px 0;
  }
  .person code {
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 11px;
    flex: 1;
  }
  .confirm {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .confirm input {
    width: auto;
  }
  .hint,
  p {
    margin-top: 16px;
  }
  .hint {
    color: var(--nc-text-secondary);
  }
  details {
    margin: 16px 0;
  }
  hr {
    border: 0;
    border-top: 1px solid var(--nc-border);
    margin: 24px 0;
  }
</style>
