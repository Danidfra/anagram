<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte';
  import FormattedMessage from './FormattedMessage.svelte';
  import { formatMessage } from '#src/utils/messageFormatting.ts';
  import type { Message } from '#src/types/chat.ts';
  import {
    parseKeyboard,
    validTarget,
    targetKey,
    type BotTarget,
    type InlineButton,
  } from '#src/stores/nostr/botKeyboardProtocol.ts';
  import { useNostrStore } from '#src/stores/nostrStore.svelte.ts';
  import type { BotInteraction } from '#src/services/botInteractionData.ts';
  import { openExternalHttpUrl } from '#src/utils/externalLinks.ts';
  import { readMessageEditPreviousEventIds } from '#src/utils/messageEdits.ts';

  let { message, children }: { message: Message; children: Snippet } = $props();
  const nostr = useNostrStore(),
    runtime = nostr.botKeyboards,
    changes = runtime.changes;
  let saved = $state<BotInteraction | undefined>();
  let sending = $state(false),
    error = $state('');
  let generation = 0,
    loadedKey = '';
  const keyboard = $derived(parseKeyboard(message.meta.inline_keyboard));
  const target = $derived<BotTarget>({
    type: message.meta.inline_keyboard_chat_type as BotTarget['type'],
    chat: message.chatId,
    root:
      message.meta.inline_keyboard_chat_type === 'public'
        ? message.id
        : (readMessageEditPreviousEventIds(message.meta)[0] ?? message.eventId ?? message.id),
    version: message.meta.inline_keyboard_version as string,
    bot: message.authorPublicKey,
  });
  $effect(() => {
    const next = target;
    const change = $changes.key;
    const key = `${nostr.getLoggedInPublicKeyHex()}:${JSON.stringify(next)}`;
    if (key === loadedKey && change !== null && change !== targetKey(next)) return;
    const token = ++generation;
    if (key !== loadedKey) {
      saved = undefined;
      loadedKey = key;
    }
    if (validTarget(next))
      void runtime
        .read(next)
        .then((value) => {
          if (token === generation) saved = value;
        })
        .catch(() => {
          if (token === generation) error = 'Could not read bot interaction';
        });
  });
  onDestroy(() => {
    generation++;
  });
  const personal = $derived(saved?.answer ?? saved?.previous);
  const personalParts = $derived(formatMessage(personal?.text ?? ''));
  const visibleKeyboard = $derived(personal?.keyboard ?? keyboard);
  async function click(button: InlineButton, retry = false) {
    if (sending) return;
    const current = target;
    sending = true;
    error = '';
    try {
      if (button.url) await openExternalHttpUrl(button.url);
      else {
        await runtime.click(
          current,
          button.callback_data!,
          personal?.keyboard ? personal.eventId : undefined,
          retry,
        );
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Bot interaction failed';
    } finally {
      sending = false;
    }
  }
</script>

{#if keyboard && validTarget(target) && !message.meta.deleted}
  <div class="bot-keyboard" data-testid="bot-keyboard">
    {#if personal}
      <div class="personal" data-testid="bot-personal-response">
        <p><FormattedMessage parts={personalParts} /></p>
      </div>
    {:else}
      {@render children()}
    {/if}
    {#each visibleKeyboard?.inline_keyboard ?? [] as row}
      <div class="button-row">
        {#each row as button}
          <button
            type="button"
            disabled={sending}
            title={button.url ?? undefined}
            onclick={() => click(button)}>{button.text}{button.url ? ' ↗' : ''}</button
          >
        {/each}
      </div>
    {/each}
    {#if saved && !saved.answer}
      <div class="pending" role="status">
        {sending ? 'Sending…' : 'Waiting for bot response.'}
        <button
          type="button"
          disabled={sending}
          onclick={() => click({ text: 'Retry', callback_data: saved!.request.data! }, true)}
          >Retry</button
        >
      </div>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
{:else}
  {@render children()}
{/if}

<style>
  .bot-keyboard {
    display: grid;
    gap: 0.35rem;
    max-width: 100%;
  }
  .button-row {
    display: flex;
    gap: 0.35rem;
  }
  .button-row button {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    padding: 0.5rem 0.65rem;
    border: 1px solid var(--border, #75869a);
    border-radius: 0.5rem;
    background: var(--surface, transparent);
    color: inherit;
    font: inherit;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: wait;
  }
  button:focus-visible {
    outline: 2px solid var(--primary, #5caef5);
    outline-offset: 2px;
  }
  .personal p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 0.25rem 0 0.5rem;
  }
  .pending {
    font-size: 0.8rem;
    opacity: 0.85;
  }
  .pending button {
    margin-left: 0.5rem;
    background: transparent;
    color: inherit;
    border: 0;
    text-decoration: underline;
    min-height: 44px;
    cursor: pointer;
  }
  .error {
    color: var(--danger, #d95363);
    margin: 0.25rem 0;
    font-size: 0.85rem;
  }
</style>
