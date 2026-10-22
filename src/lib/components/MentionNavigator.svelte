<script lang="ts">
  import Icon from './Icon.svelte';

  interface Props {
    // Previously unread mentions, oldest first.
    ids: string[];
    // Scrolls to and highlights a message; false when it can no longer be shown.
    onjump: (id: string) => Promise<boolean>;
    ondismiss: () => void;
  }
  let { ids, onjump, ondismiss }: Props = $props();
  let missing = $state<string[]>([]);
  let current = $state('');
  let busy = $state(false);
  const mentions = $derived(ids.filter((id) => !missing.includes(id)));
  const index = $derived(mentions.indexOf(current));

  async function step(direction: 1 | -1) {
    if (busy) return;
    busy = true;
    try {
      // A deleted or unavailable mention is skipped in the same direction.
      let next = index < 0 ? 0 : index + direction;
      while (mentions[next]) {
        const id = mentions[next]!;
        if (await onjump(id)) {
          current = id;
          return;
        }
        // Dropping it shifts later mentions down one place; earlier ones keep their index.
        missing = [...missing, id];
        if (direction < 0) next -= 1;
      }
    } finally {
      busy = false;
    }
  }
</script>

{#if mentions.length}<div
    class="mention-nav"
    role="group"
    aria-label="Unread mentions"
    data-testid="mention-navigator"
  >
    <button
      class="icon-button"
      aria-label="Previous mention"
      data-testid="mention-navigator-previous"
      disabled={busy || index <= 0}
      onclick={() => step(-1)}><Icon name="up" /></button
    ><span class="mention-nav-position" aria-live="polite" data-testid="mention-navigator-position"
      >@ {index < 0 ? mentions.length : `${index + 1}/${mentions.length}`}</span
    ><button
      class="icon-button"
      aria-label="Next mention"
      data-testid="mention-navigator-next"
      disabled={busy || index >= mentions.length - 1}
      onclick={() => step(1)}><Icon name="down" /></button
    ><button
      class="icon-button"
      aria-label="Dismiss mention navigation"
      data-testid="mention-navigator-dismiss"
      onclick={ondismiss}><Icon name="close" /></button
    >
  </div>{/if}
