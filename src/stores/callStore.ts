import { syncClosedAndroidCalls } from '#src/services/androidCallNotificationService.ts';
import type { CallSignal } from '#src/types/call.ts';
import { createStore } from '#src/lib/state/store.svelte.ts';
import {
  callMediaSupported,
  createCallMediaReceiver,
  getCallCamera,
  getCallMedia,
  getCallMicrophone,
  getCallScreen,
  recordCallMedia,
} from '#src/services/callMediaService.ts';
import { primeCallAudio } from '#src/services/callPlaybackService.ts';
import { hasSeenCallControl, rememberCallControl } from '#src/services/callReplayCache.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { createIrohCallEndpoint } from '#src/services/irohCallTransport.ts';
import { useCallRoomStore } from '#src/stores/callRoomStore.ts';
import { useMessageStore } from '#src/stores/messageStore.svelte.ts';
import { createCallRuntime } from '#src/stores/nostr/callRuntime.svelte.ts';
import { resolveIncomingChatInboxStateValue } from '#src/stores/nostr/valueUtils.ts';
import { useNostrStore } from '#src/stores/nostrStore.svelte.ts';
import type { CallMode } from '#src/types/call.ts';
import { callHistoryFromSession } from '#src/utils/callHistory.ts';

export const useCallStore = createStore('calls', () => {
  const runtime = createCallRuntime({
    async onEnded(session) {
      await useMessageStore().sendCallHistory(session.peerPubkey, callHistoryFromSession(session));
    },
    sendSignal: (peer, signal) => useNostrStore().sendCallSignal(peer, signal),
    getOwnPubkey: () => useNostrStore().getLoggedInPublicKeyHex(),
    async resolvePeer(peer) {
      const nostr = useNostrStore();
      if (nostr.isPubkeyBlocked(peer)) return null;
      const [contact, chat] = await Promise.all([
        contactsService.getContactByPublicKey(peer),
        chatDataService.getChatByPublicKey(peer),
      ]);
      if (
        contact?.type === 'group' ||
        chat?.type === 'group' ||
        contact?.meta.blocked ||
        chat?.meta?.inbox_state === 'blocked' ||
        contact?.meta.muted ||
        chat?.meta?.muted
      )
        return null;
      if (
        resolveIncomingChatInboxStateValue({
          chat,
          isAcceptedContact: contact?.meta.private_contact_list_member === true,
        }) !== 'accepted'
      )
        return null;
      return { name: contact?.name || chat?.name || peer.slice(0, 12) };
    },
    supported: callMediaSupported,
    otherCallBusy: () => useCallRoomStore().busy,
    hasSeen: (peer, id) =>
      hasSeenCallControl(useNostrStore().getLoggedInPublicKeyHex() ?? '', peer, id),
    remember: (peer, id) =>
      rememberCallControl(useNostrStore().getLoggedInPublicKeyHex() ?? '', peer, id),
    createEndpoint: () => createIrohCallEndpoint(useNostrStore().getIrohRelays()),
    getMedia: getCallMedia,
    getMicrophone: getCallMicrophone,
    getCamera: getCallCamera,
    getScreen: getCallScreen,
    unlockPlayback: primeCallAudio,
    createReceiver: createCallMediaReceiver,
    record: recordCallMedia,
  });
  const { receiveSignal, start } = runtime;
  return Object.assign(runtime, {
    async receiveSignal(peer: string, signal: CallSignal) {
      if (signal.action === 'invite') await syncClosedAndroidCalls();
      return receiveSignal(peer, signal);
    },
    async start(peer: string, mode: CallMode) {
      if (useCallRoomStore().busy) {
        runtime.error = 'room.error.busy';
        return;
      }
      await start(peer, mode);
    },
  });
});
