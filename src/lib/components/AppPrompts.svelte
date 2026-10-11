<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { appPrompts } from '#src/lib/platform/ui.ts';
  import ModalFrame from './ModalFrame.svelte';

  onDestroy(() => {
    for (const prompt of get(appPrompts)) prompt.finish(false);
  });
</script>

{#if $appPrompts[0]}
  {@const prompt = $appPrompts[0]}
  {#key prompt.id}
    <ModalFrame
      title={prompt.title}
      persistent={prompt.persistent}
      onclose={() => prompt.finish(false)}
    >
      <p>{prompt.message}</p>
      {#each prompt.choices as choice (choice.value)}
        <label
          ><input type="checkbox" bind:group={prompt.selected} value={choice.value} />
          {choice.label}</label
        >
      {/each}
      <footer>
        <button class="outline" onclick={() => prompt.finish(false)}>{prompt.cancelLabel}</button>
        <button class="primary" onclick={() => prompt.finish(true, prompt.selected)}
          >{prompt.allowLabel}</button
        >
      </footer>
    </ModalFrame>
  {/key}
{/if}

<style>
  p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }
</style>
