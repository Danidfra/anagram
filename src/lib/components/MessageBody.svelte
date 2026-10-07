<script lang="ts">
  import type { Message } from '#src/types/chat.ts';
  import { buildMessageTextParts, withoutPreviewMediaUrls } from '#src/utils/messageTextParts.ts';
  import { openExternalHttpUrl } from '#src/utils/externalLinks.ts';
  import { parseRoomLink } from '#src/utils/callRoom.ts';
  import { readCallHistory, callHistoryDuration } from '#src/utils/callHistory.ts';
  import { useTrustedMediaStore } from '#src/stores/trustedMediaStore.ts';
  import { portal } from '#src/lib/actions/portal.ts';
  import { observe } from '#src/lib/state/store.ts';
  import { Notify } from '#src/lib/platform/ui.ts';
  import { translate } from '#src/i18n.ts';
  import type { NostrMentionProfile } from '#src/utils/nostrMentions.ts';
  import Icon from './Icon.svelte';
  import { isSingleEmoji } from '#src/utils/singleEmoji.ts';
  import MediaViewer from './MediaViewer.svelte';
  import LinkPreview from './LinkPreview.svelte';
  import { previewUrl } from '#src/utils/linkPreview.ts';
  import {
    shouldCollapseMessageText,
    truncateCollapsedMessageText,
  } from '#src/utils/messageTextExpansion.ts';
  import type { CallMode } from '#src/types/call.ts';
  export let mentionProfiles: NostrMentionProfile[] = [];
  export let canRedial = false;
  export let onredial: (mode: CallMode) => void = () => {};
  export let message: Message;
  export let bubbleLayout = false;
  export let oncontact: (pubkey: string) => void;
  export let onroom: (link: string) => void;
  const trusted = useTrustedMediaStore();
  const trust = observe(() => trusted.trustedImageSenderPublicKeys);
  let imageUrl = '';
  let imageName = '';
  let revealDeleted = false;
  let expanded = false,
    showMedia = false;
  $: history = readCallHistory(message.meta.call_history);
  $: caption = mediaAllowed
    ? withoutPreviewMediaUrls(message.text, message.meta.attachments ?? [])
    : message.text;
  $: text = expanded ? caption : truncateCollapsedMessageText(caption);
  $: parts = buildMessageTextParts(text, mentionProfiles).map((part) => ({
    ...part,
    roomLink: part.type === 'url' && Boolean(parseRoomLink(part.href)),
  }));
  $: previewLinks = [
    ...new Set(
      parts.flatMap((part) =>
        part.type === 'url' &&
        !part.roomLink &&
        previewUrl(part.href) &&
        !(message.meta.attachments ?? []).some((attachment) => attachment.url === part.href) &&
        !/\.(?:png|jpe?g|gif|webp|svg|avif|mp4|webm|mov|mp3|ogg|wav|pdf)(?:[?#]|$)/i.test(part.href)
          ? [part.href]
          : [],
      ),
    ),
  ].slice(0, 2);
  $: mediaAllowed =
    showMedia || message.sender === 'me' || $trust.includes(message.authorPublicKey);
  async function open(url: string) {
    if (parseRoomLink(url)) {
      onroom(url);
      return;
    }
    try {
      await openExternalHttpUrl(url);
    } catch (error) {
      Notify.create({ message: String(error), type: 'negative' });
    }
  }
  let linkMenu: { href: string; x: number; y: number; media?: boolean } | null = null;
  let menuTrigger: HTMLButtonElement | null = null;
  function closeLinkMenu(restoreFocus = false) {
    linkMenu = null;
    if (restoreFocus) menuTrigger?.focus({ preventScroll: true });
    menuTrigger = null;
  }
  function mediaOptions(event: MouseEvent, href: string) {
    const button = event.currentTarget as HTMLButtonElement;
    if (linkMenu?.href === href) {
      closeLinkMenu(true);
      return;
    }
    menuTrigger = button;
    const rect = button.getBoundingClientRect();
    linkMenu = {
      href,
      media: true,
      x: Math.max(8, Math.min(rect.right - 160, innerWidth - 168)),
      y: Math.max(8, Math.min(rect.bottom + 4, innerHeight - 100)),
    };
  }
  function focusMenu(node: HTMLElement) {
    if (menuTrigger) node.querySelector<HTMLButtonElement>('button')?.focus();
  }
  async function copyLink() {
    const href = linkMenu?.href;
    closeLinkMenu(true);
    if (!href) return;
    try {
      await navigator.clipboard.writeText(href);
    } catch {
      Notify.create({ message: 'Could not copy link.', type: 'negative' });
    }
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (!(
      event.target instanceof Element &&
      event.target.closest('[data-message-link-menu], [data-media-options]')
    ))
      closeLinkMenu();
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape' && linkMenu) closeLinkMenu(true);
  }}
/>
{#if linkMenu}<div
    use:portal
    use:focusMenu
    class="link-menu"
    data-message-link-menu
    role="menu"
    style:left={`${linkMenu.x}px`}
    style:top={`${linkMenu.y}px`}
  >
    <button role="menuitem" data-testid="message-link-copy" onclick={copyLink}>Copy link</button>
    {#if linkMenu.media}<button
        role="menuitem"
        onclick={() => {
          const href = linkMenu?.href;
          closeLinkMenu(true);
          if (href) void open(href);
        }}>Open original</button
      >{/if}
  </div>{/if}

{#if message.meta.deleted}<em>{$translate('Message deleted')}</em>
  <button class="link" onclick={() => (revealDeleted = !revealDeleted)}
    >{revealDeleted ? 'Hide Deleted Message' : 'View Deleted Message'}</button
  >
  {#if revealDeleted}<span class="message-text">{message.text}</span>{/if}
{:else if history}<div class="call-history" data-testid="message-call-history">
    <button
      class="icon-button"
      data-testid="message-call-again"
      aria-label={$translate('call.again')}
      disabled={!canRedial}
      onclick={() => history && onredial(history.mode)}><Icon name="phone" /></button
    >
    <div>
      <div>
        {$translate(history.mode === 'video' ? 'call.history.video' : 'call.history.audio')}
      </div>
      <small
        >{$translate(message.sender === 'me' ? 'call.history.outgoing' : 'call.history.incoming')} · {history.connected
          ? callHistoryDuration(history.duration)
          : $translate(`call.history.${history.reason}`)}</small
      >
    </div>
  </div>
{:else if message.meta.group_epoch_notice}<span class="epoch-notice"
    >{$translate('Group keys updated')} · {message.text}</span
  >
{:else}
  <div
    class="message-body"
    class:bubble-media-body={bubbleLayout &&
      mediaAllowed &&
      (message.meta.attachments ?? []).some(
        (attachment) =>
          /^(image|video)\//.test(attachment.mimeType) && /^https:\/\//.test(attachment.url),
      )}
  >
    {#if text}<span
        class="message-text"
        class:single-emoji={isSingleEmoji(message.text) && !message.meta.attachments?.length}
        >{#each parts as part (part.key)}{#if part.type === 'url'}<a
              data-testid="message-url-link"
              class:room-link={part.roomLink}
              href={part.href}
              rel="noopener noreferrer"
              target="_blank"
              oncontextmenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                linkMenu = {
                  href: part.href,
                  x: Math.max(8, Math.min(event.clientX, innerWidth - 160)),
                  y: Math.max(8, Math.min(event.clientY, innerHeight - 55)),
                };
              }}
              onclick={(e) => {
                e.preventDefault();
                void open(part.href);
              }}
              >{#if part.roomLink}{$translate('room.joinGroupCall')}<Icon
                  name="group"
                />{:else}{part.text}{/if}</a
            >{:else if part.type === 'mention' && part.publicKey}<button
              class="mention"
              data-testid="message-mention-link"
              onclick={() => oncontact(part.publicKey!)}>{part.text}</button
            >{:else}{part.text}{/if}{/each}</span
      >
    {/if}
    {#if shouldCollapseMessageText(caption)}<button
        class="link"
        onclick={() => (expanded = !expanded)}
        >{$translate(expanded ? 'Show less' : 'Show more')}</button
      >{/if}
    {#each previewLinks as url (url)}
      <LinkPreview {url} allowed={mediaAllowed} onopen={open} />
    {/each}
    {#if message.meta.attachments?.length && !mediaAllowed}<div class="media-prompt">
        <button class="outline" onclick={() => (showMedia = true)}
          >{$translate('Load media')}</button
        ><button class="link" onclick={() => trusted.trustImageSender(message.authorPublicKey)}
          >{$translate('Always load media from this sender')}</button
        >
      </div>{/if}
    {#if mediaAllowed}
      {#each message.meta.attachments ?? [] as attachment}
        {#if /^https:\/\//.test(attachment.url)}
          {#if /^(image|video)\//.test(attachment.mimeType)}
            <div class="media-attachment">
              {#if attachment.mimeType.startsWith('image/')}<a
                  href={attachment.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onclick={(e) => {
                    e.preventDefault();
                    imageUrl = attachment.url;
                    imageName = attachment.name ?? 'attachment';
                  }}
                  ><img
                    src={attachment.url}
                    alt={attachment.name ?? 'Attachment'}
                    loading="lazy"
                    referrerpolicy="no-referrer"
                  /></a
                >
              {:else}<!-- svelte-ignore a11y_media_has_caption --><video
                  src={attachment.url}
                  controls
                  preload="none"
                ></video>{/if}
              <div class="media-footer">
                <button
                  class="icon-button media-options"
                  data-media-options
                  aria-label="Media options"
                  title="Media options"
                  aria-haspopup="menu"
                  aria-expanded={linkMenu?.media === true && linkMenu.href === attachment.url}
                  onclick={(event) => mediaOptions(event, attachment.url)}
                  ><Icon name="more" /></button
                >
              </div>
            </div>
          {:else if attachment.mimeType.startsWith('audio/')}<audio
              src={attachment.url}
              controls
              preload="none"
            ></audio>
          {:else}<a
              href={attachment.url}
              target="_blank"
              rel="noopener noreferrer"
              onclick={(e) => {
                e.preventDefault();
                void open(attachment.url);
              }}>{attachment.name ?? 'Download attachment'}</a
            >{/if}
        {/if}
      {/each}
    {/if}
  </div>
{/if}

{#if imageUrl}<MediaViewer url={imageUrl} name={imageName} onclose={() => (imageUrl = '')} />{/if}

<style>
  .message-body {
    display: contents;
  }
  .bubble-media-body {
    display: flex;
    flex-direction: column;
  }
  .bubble-media-body > .message-text,
  .bubble-media-body > .link {
    order: 1;
  }

  .link-menu {
    position: fixed;
    z-index: 100;
    padding: 6px;
    min-width: 140px;
    border: 1px solid var(--nc-border);
    border-radius: 8px;
    background: var(--nc-menu-bg);
    box-shadow: 0 4px 18px #0005;
  }
  .link-menu button {
    width: 100%;
    text-align: left;
    padding: 8px;
  }
  .message-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .single-emoji {
    font-size: 3em;
  }
  a,
  .mention {
    color: var(--q-primary);
  }
  .room-link {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border: 1px solid var(--q-primary);
    border-radius: 10px;
    text-decoration: none;
    white-space: normal;
    vertical-align: middle;
    font-weight: 600;
  }
  .room-link:hover {
    background: color-mix(in srgb, var(--q-primary) 12%, transparent);
  }
  .room-link:focus-visible {
    outline: 2px solid var(--q-primary);
    outline-offset: 2px;
  }
  .mention {
    padding: 0;
  }
  .call-history {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .call-history small,
  .epoch-notice {
    color: var(--nc-text-secondary);
  }
  img,
  video {
    display: block;
    max-width: min(100%, 480px);
    max-height: 400px;
    border-radius: 10px;
    margin: 10px 0;
  }
  .media-attachment {
    width: fit-content;
    max-width: 100%;
  }
  .media-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: -6px;
  }
  .media-options {
    width: 28px;
    height: 28px;
  }
  .media-prompt {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin: 10px 0;
  }
  audio {
    max-width: 100%;
    margin: 10px 0;
  }
</style>
