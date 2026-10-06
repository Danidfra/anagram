import { afterEach, describe, expect, it, vi } from 'vitest';
import NostrClient, { NostrPrivateKeySigner } from '#src/lib/nostr/client.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { createGroupEpochPublishRuntime } from '#src/stores/nostr/groupEpochPublishRuntime.ts';
import type { ContactRecord } from '#src/types/contact.ts';

afterEach(() => vi.restoreAllMocks());

describe('owner epoch history backup', () => {
  it('keeps the previous epoch intact if no relay accepts its encrypted owner ticket', async () => {
    const ndk = new NostrClient();
    const group = NostrPrivateKeySigner.generate();
    const owner = NostrPrivateKeySigner.generate();
    const epoch = NostrPrivateKeySigner.generate();
    const contact: ContactRecord = {
      id: 1,
      public_key: group.pubkey,
      type: 'group',
      name: 'Group',
      given_name: null,
      meta: { owner_public_key: owner.pubkey, group_private_key_encrypted: 'encrypted-backup' },
      relays: [{ url: 'wss://group.example/', read: true, write: true }],
      sendMessagesToAppRelays: false,
    };
    vi.spyOn(contactsService, 'init').mockResolvedValue();
    vi.spyOn(contactsService, 'getContactByPublicKey').mockResolvedValue(contact);
    const update = vi.spyOn(contactsService, 'updateContact');
    const deps: Parameters<typeof createGroupEpochPublishRuntime>[0] = {
      ndk,
      appendRelayStatusesToGroupMemberTicketEvent: vi.fn(async () => {}),
      buildFailedOutboundRelayStatuses: () => [],
      buildPendingOutboundRelayStatuses: () => [],
      buildRelaySaveStatus: () => ({
        relayUrls: ['wss://group.example/'],
        publishedRelayUrls: [],
        failedRelayUrls: ['wss://group.example/'],
        errorMessage: null,
      }),
      encryptGroupIdentitySecretContent: vi.fn(async () => 'next-encrypted-backup'),
      ensureGroupIdentitySecretEpochState: async () => ({
        contact,
        secret: {
          version: 1,
          group_pubkey: group.pubkey,
          group_privkey: group.privateKey,
          epoch_number: 0,
          epoch_privkey: epoch.privateKey,
        },
      }),
      ensureRelayConnections: vi.fn(async () => {}),
      getAppRelayUrls: () => ['wss://group.example/'],
      getLoggedInPublicKeyHex: () => owner.pubkey,
      giftWrapSignedEvent: vi.fn(async (event) => event),
      normalizeEventId: (value) => (typeof value === 'string' ? value : null),
      persistIncomingGroupEpochTicket: vi.fn(async () => {}),
      publishEventWithRelayStatuses: vi.fn(async () => ({ relayStatuses: [], error: null })),
      publishGroupIdentitySecret: vi.fn(),
      publishGroupMembershipFollowSet: vi.fn(),
      publishGroupMembershipRosterFollowSet: vi.fn(),
      toIsoTimestampFromUnix: (value) => new Date((value ?? 0) * 1000).toISOString(),
      toStoredNostrEvent: async (event) => event.rawEvent(),
    };
    const runtime = createGroupEpochPublishRuntime(deps);
    await expect(runtime.rotateGroupEpochAndSendTickets(group.pubkey, [])).rejects.toThrow(
      'Could not back up the previous group epoch',
    );
    expect(deps.giftWrapSignedEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 1014,
        pubkey: group.pubkey,
        tags: [
          ['p', owner.pubkey],
          ['epoch', '0'],
        ],
      }),
      expect.objectContaining({ pubkey: owner.pubkey }),
      expect.anything(),
    );
    expect(update).not.toHaveBeenCalled();
    expect(deps.encryptGroupIdentitySecretContent).not.toHaveBeenCalled();
    expect(deps.persistIncomingGroupEpochTicket).not.toHaveBeenCalled();
    expect(deps.publishGroupMembershipRosterFollowSet).not.toHaveBeenCalled();
    expect(deps.publishGroupIdentitySecret).not.toHaveBeenCalled();
  });
});
