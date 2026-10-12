type ThreadMessage = { chatId: string; id: string };
const listeners = new Set<(message: ThreadMessage) => void>();

/** Transient UI activity only: restored history and delivery updates do not emit. */
export function notifyLiveThreadMessage(chatId: string, id: string) {
  for (const listener of listeners) {
    try {
      listener({ chatId, id });
    } catch (error) {
      // A view failure must never interrupt message persistence or publication.
      console.error('Could not update the live thread position', error);
    }
  }
}

export function onLiveThreadMessage(listener: (message: ThreadMessage) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
