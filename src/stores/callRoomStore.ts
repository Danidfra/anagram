import { get } from 'svelte/store';
import { groupCallNames } from '#src/lib/state/groupCallNames.ts';
import { createStore } from '#src/lib/state/store.svelte.ts';
import {
  callMediaSupported,
  callPacketVideoSupported,
  prepareCallPacketAudio,
  createCallMediaReceiver,
  getCallCamera,
  getCallMedia,
  getCallMicrophone,
  getCallScreen,
  recordCallMedia,
} from '#src/services/callMediaService.ts';
import { primeCallAudio } from '#src/services/callPlaybackService.ts';
import { acquireMobileCallAudio, hasMobileCallAudio } from '#src/services/mobileCallAudio.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { createIrohCallEndpoint } from '#src/services/irohCallTransport.ts';
import { useCallStore } from './callStore';
import { createCallRoomRuntime } from './nostr/callRoomRuntime.svelte.ts';
import { useNostrStore } from './nostrStore.svelte.ts';

export const useCallRoomStore = createStore('callRooms', () =>
  createCallRoomRuntime({
    getOwnPubkey: () => useNostrStore().getLoggedInPublicKeyHex(),
    async getIdentity() {
      const nostr = useNostrStore();
      const own = nostr.getLoggedInPublicKeyHex();
      if (!own) throw new Error('No active account');
      const contact = await contactsService.getContactByPublicKey(own);
      return {
        name:
          get(groupCallNames(own)).name.trim() ||
          contact?.meta.nip05?.trim() ||
          contact?.name ||
          own.slice(0, 12),
        relays: await nostr.listPrivateMessageReadRelayUrls(),
      };
    },
    isBlocked: (peer) => useNostrStore().isPubkeyBlocked(peer),
    otherCallBusy: () => {
      const session = useCallStore().session;
      return Boolean(session && session.phase !== 'ended');
    },
    send: (peer, signal, relays) => useNostrStore().sendRoomSignal(peer, signal, relays),
    media: {
      supported: callMediaSupported,
      preparePacketAudio: prepareCallPacketAudio,
      packetVideoSupported: callPacketVideoSupported,
      getMedia: getCallMedia,
      getCamera: getCallCamera,
      getMicrophone: getCallMicrophone,
      getScreen: getCallScreen,
      createEndpoint: () => createIrohCallEndpoint(useNostrStore().getIrohRelays()),
      createReceiver: createCallMediaReceiver,
      record: recordCallMedia,
      unlockPlayback: primeCallAudio,
      ...(hasMobileCallAudio() ? { acquireAudioRoute: acquireMobileCallAudio } : {}),
    },
  }),
);
