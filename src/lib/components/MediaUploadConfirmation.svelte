<script lang="ts">
  import { translate } from '#src/i18n.ts';
  export let fileName: string;
  export let serverUrl: string;
  export let busy = false;
  export let publicUpload = false;
  export let oncancel: () => void;
  export let onconfirm: () => void;
</script>

<p>
  {publicUpload ? 'This file and its link will be public.' : $translate('message.mediaUrlWarning')}
</p>
<p>{$translate('message.mediaUpload.usingBlossomServer', { server: serverUrl })}</p>
<p>{fileName}</p>
<button class="outline" disabled={busy} onclick={oncancel}>{$translate('common.cancel')}</button>
<button class="primary" disabled={busy} onclick={onconfirm}
  >{busy
    ? $translate('Uploading…')
    : publicUpload
      ? 'Upload and send'
      : $translate('common.ok')}</button
>
