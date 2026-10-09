<script lang="ts">
  import type { Snippet } from 'svelte';
  import { messagePress } from '#src/lib/actions/messagePress.ts';
  import {
    isQuickReplyIgnoredTarget,
    messageSwipeReply,
  } from '#src/lib/actions/messageQuickReply.ts';
  import type { Message } from '#src/types/chat.ts';
  import { locale } from '#src/i18n.ts';
  import { chatTime } from '#src/utils/chatDate.ts';
  import Avatar from './Avatar.svelte';
  import MessageRelayStatus from './MessageRelayStatus.svelte';
  import MessageReactions from './MessageReactions.svelte';
  interface Props {
    message: Message;
    author: { name: string; picture?: string };
    authorLabel?: Snippet | undefined;
    allowAvatar?: boolean;
    bubbleLayout?: boolean;
    continuesSender?: boolean;
    senderContinues?: boolean;
    dayLabel: string;
    highlighted?: boolean;
    contextOpen?: boolean;
    contactName?: string;
    contactRelayUrls?: string[];
    publicGroup?: boolean;
    onreaction?: ((emoji: string, remove: boolean) => Promise<void>) | undefined;
    reactionsReadonly?: boolean;
    onretry?: ((url: string) => Promise<void>) | undefined;
    onauthor: (key: string) => void;
    onactions?: ((event: MouseEvent) => void) | undefined;
    // Quick reply (mouse double-click, touch swipe); omitted rows have no gesture.
    onreply?: (() => void) | undefined;
    children: Snippet;
  }

  let {
    message,
    author,
    authorLabel = undefined,
    allowAvatar = true,
    bubbleLayout = false,
    continuesSender = false,
    senderContinues = false,
    dayLabel,
    highlighted = false,
    contextOpen = false,
    contactName = '',
    contactRelayUrls = [],
    publicGroup = false,
    onreaction = undefined,
    reactionsReadonly = false,
    onretry = undefined,
    onauthor,
    onactions = undefined,
    onreply = undefined,
    children,
  }: Props = $props();
  // dblclick is a MouseEvent without pointerType; remember the input that
  // started it so touch-generated double taps never reply.
  let pointerType = '';
  function quickReply(event: MouseEvent) {
    if (
      !onreply ||
      pointerType !== 'mouse' ||
      event.button !== 0 ||
      message.meta.deleted ||
      isQuickReplyIgnoredTarget(event.target)
    )
      return;
    onreply();
  }
</script>

{#snippet name()}{#if authorLabel}{@render authorLabel()}{:else}{author.name}{/if}{/snippet}
<article
  class="message-row"
  class:context-open={contextOpen}
  class:highlighted
  class:sender-continuation={continuesSender}
  class:sender-continues={senderContinues}
  class:own={message.sender === 'me'}
  id="message-{message.id}"
  data-testid={publicGroup ? 'public-message' : 'message-bubble'}
  data-event-id={message.eventId ?? message.id}
  data-chat-public-key={message.chatId}
  data-author-public-key={message.authorPublicKey}
  data-day-label={dayLabel}
  onpointerdown={(event) => (pointerType = event.pointerType)}
  ondblclick={quickReply}
  use:messageSwipeReply={{
    disabled: !onreply || Boolean(message.meta.deleted),
    onreply: () => onreply?.(),
  }}
>
  {#if bubbleLayout}
    {#if !senderContinues}<button
        class="bubble-avatar"
        data-testid="thread-author-profile-link"
        aria-label={`Open profile: ${author.name}`}
        onclick={() => onauthor(message.authorPublicKey)}
      >
        <Avatar
          publicKey={allowAvatar ? message.authorPublicKey : ''}
          picture={allowAvatar ? (author.picture ?? '') : ''}
          name={author.name}
          size={38}
          eager
        />
      </button>{/if}
  {:else}
    <button
      class="message-author"
      data-testid="thread-author-profile-link"
      onclick={() => onauthor(message.authorPublicKey)}
    >
      <Avatar
        publicKey={allowAvatar ? message.authorPublicKey : ''}
        picture={allowAvatar ? (author.picture ?? '') : ''}
        name={author.name}
        size={36}
        eager
      />
      <strong>{@render name()}</strong>
    </button>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_static_element_interactions -->
  <div
    class="message-content"
    tabindex={onactions && !message.meta.deleted ? 0 : undefined}
    oncontextmenu={message.meta.deleted ? undefined : onactions}
    use:messagePress={Boolean(onactions) && !message.meta.deleted}
  >
    {#if bubbleLayout && !continuesSender}<button
        class="bubble-author-name"
        data-testid="thread-author-name-link"
        style:color={`var(--bubble-author-${(Number.parseInt(message.authorPublicKey.slice(0, 8), 16) || 0) % 6})`}
        onclick={() => onauthor(message.authorPublicKey)}>{@render name()}</button
      >{/if}
    {@render children()}
    <div
      class:bubble-footer={bubbleLayout &&
        !message.meta.deleted &&
        Boolean(message.meta.reactions?.length)}
      class:bubble-time-only={bubbleLayout &&
        (message.meta.deleted || !message.meta.reactions?.length)}
    >
      <span class="message-time"
        >{#if message.meta.edited && !message.meta.deleted}<span data-testid="message-edited-label"
            >edited ·
          </span>{/if}{chatTime(
          message.sentAt,
          $locale,
        )}{#if !message.meta.deleted}<MessageRelayStatus
            {message}
            {contactName}
            {contactRelayUrls}
            {publicGroup}
            {onretry}
          />{/if}</span
      >
      {#if message.meta.reactions?.length && !message.meta.deleted}<MessageReactions
          {message}
          ontoggle={onreaction}
          readonly={reactionsReadonly}
        />{/if}
    </div>
  </div>
</article>
