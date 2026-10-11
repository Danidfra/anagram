<script lang="ts">
  import { translate } from '#src/i18n.ts';
  import {
    DEFAULT_CUSTOM_NAME_CSS,
    groupCallNames,
    saveGroupCallName,
    type GroupCallName,
  } from '#src/lib/state/groupCallNames.ts';
  export let account: string;
  export let showName = true;
  export let onnamechange: ((name: string) => Promise<void>) | undefined = undefined;
  let saving = false;
  async function applyName() {
    if (!onnamechange || saving) return;
    saving = true;
    try {
      await onnamechange(value.name);
    } finally {
      saving = false;
    }
  }
  $: preferences = groupCallNames(account);
  $: value = $preferences;
  function change(patch: Partial<GroupCallName>) {
    saveGroupCallName(account, { ...value, ...patch });
  }
</script>

<div class="group-call-name-fields">
  {#if showName}<label
      >{$translate('room.customName')}<input
        maxlength="80"
        value={value.name}
        placeholder={$translate('room.customNamePlaceholder')}
        oninput={(e) => change({ name: e.currentTarget.value })}
      /></label
    >
    {#if onnamechange}<button type="button" class="primary" disabled={saving} onclick={applyName}
        >{$translate('common.save')}</button
      >{/if}
  {/if}
  <label class="name-css-toggle"
    ><input
      type="checkbox"
      role="switch"
      checked={value.cssEnabled}
      onchange={(e) => change({ cssEnabled: e.currentTarget.checked })}
    />{$translate('room.customNameCss')}</label
  >
  {#if value.cssEnabled}<label
      >CSS<textarea
        spellcheck="false"
        rows="9"
        value={value.css}
        oninput={(e) => change({ css: e.currentTarget.value })}></textarea></label
    >
    <button type="button" class="outline" onclick={() => change({ css: DEFAULT_CUSTOM_NAME_CSS })}
      >{$translate('room.resetNameCss')}</button
    >{/if}
</div>

<style>
  .group-call-name-fields {
    min-width: 0;
  }
  .name-css-toggle {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .name-css-toggle input {
    width: auto;
    margin: 0;
  }
  textarea {
    font-family: monospace;
    resize: vertical;
  }
</style>
