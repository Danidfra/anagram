<script lang="ts">
  import type { Message, MessageRelayStatus } from '#src/types/chat.ts';
  import { translate } from '#src/i18n.ts';
  export let message: Message;
  export let onretry: (status: MessageRelayStatus) => Promise<void>;
  let error = '';
  let notice = '';
  let busy = false;
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      await fn();
    } catch (cause) {
      error = String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<dl class="message-info">
  <dt>{$translate('common.sent')}</dt>
  <dd>{new Date(message.sentAt).toLocaleString()}</dd>
  <dt>{$translate('contacts.authorPubkey')}</dt>
  <dd>{message.authorPublicKey}</dd>
  <dt>{$translate('message.eventId')}</dt>
  <dd>{message.eventId || 'Not published yet'}</dd>
</dl>
<button
  class="outline"
  disabled={!message.eventId}
  onclick={() =>
    act(async () => {
      await navigator.clipboard.writeText(message.eventId ?? '');
      // App notices render behind this modal dialog; confirm in place.
      notice = $translate('common.copiedLabel', { label: $translate('message.eventId') });
    })}>Copy event ID</button
>
{#if notice}<p role="status">{notice}</p>{/if}
{#each message.nostrEvent?.relay_statuses ?? [] as status}<p>
    {status.relay_url} — {status.status}
    {#if message.sender === 'me' && status.status === 'failed' && (status.scope === 'recipient' || status.scope === 'self')}<button
        class="outline"
        disabled={busy}
        onclick={() => act(() => onretry(status))}>Retry</button
      >{/if}
  </p>{/each}
{#if message.nostrEvent?.event}<details>
    <summary>Event JSON</summary>
    <pre class="event-json">{JSON.stringify(message.nostrEvent.event, null, 2)}</pre>
  </details>{/if}
{#if error}<p role="alert" class="error">{error}</p>{/if}
