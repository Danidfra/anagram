import { invoke, isTauri } from '@tauri-apps/api/core';

type Options = {
  enabled: () => boolean;
  context: () => string;
  onfile: (file: File) => void;
};

export function nativeImagePaste(node: HTMLTextAreaElement, options: Options) {
  if (!isTauri() || !/Linux/.test(navigator.userAgent) || /Android/.test(navigator.userAgent))
    return;
  let revision = 0;
  const cancel = () => {
    revision++;
  };
  const paste = async (event: ClipboardEvent) => {
    const current = ++revision;
    const data = event.clipboardData;
    // Leave ordinary text and the existing file-paste handler alone. Never read
    // the native clipboard in response to a script-generated paste event.
    if (
      !event.isTrusted ||
      !options.enabled() ||
      !data ||
      data.files.length ||
      ['text/plain', 'text/html', 'text/uri-list'].some((type) => data.getData(type))
    )
      return;
    const context = options.context();
    try {
      const bytes = await invoke<ArrayBuffer>('read_clipboard_image');
      if (
        current !== revision ||
        !node.isConnected ||
        node.ownerDocument.activeElement !== node ||
        context !== options.context() ||
        !options.enabled() ||
        !bytes.byteLength
      )
        return;
      options.onfile(new File([bytes], 'image.png', { type: 'image/png' }));
    } catch {
      // Clipboard formats can be unavailable; the attachment picker still works.
    }
  };
  node.addEventListener('paste', paste);
  node.addEventListener('blur', cancel);
  return {
    destroy() {
      cancel();
      node.removeEventListener('paste', paste);
      node.removeEventListener('blur', cancel);
    },
  };
}
