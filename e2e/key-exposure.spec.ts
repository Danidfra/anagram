import { expect, test } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19, nip44, nip59 } from 'nostr-tools';
import {
  bootstrapSessionOnPage,
  createGroup,
  navigateToChat,
  sendMessage,
  TEST_ACCOUNTS,
  waitForThreadMessage,
  reloadAndWaitForApp,
} from './parity/helpers';

// Only generated test credentials are used. Never attach captured traffic or keys.
test('private login, group messages and call signals keep keys out of traffic, logs and diagnostics', async ({
  page,
}) => {
  const account = TEST_ACCOUNTS.keyExposure;
  const sender = getPublicKey(Uint8Array.from(Buffer.from(account.privateKey, 'hex')));
  const outbound: string[] = [];
  const logs: string[] = [];
  const consoleSnapshots: Promise<void>[] = [];
  page.on('request', (request) =>
    outbound.push(JSON.stringify([request.url(), request.headers(), request.postData()])),
  );
  page.on('websocket', (socket) => {
    outbound.push(socket.url());
    socket.on('framesent', ({ payload }) => outbound.push(payload.toString()));
  });
  page.on('console', (message) => {
    logs.push(message.text());
    consoleSnapshots.push(
      Promise.all(message.args().map((arg) => arg.jsonValue()))
        .then((args) => {
          logs.push(JSON.stringify(args));
        })
        .catch(() => {
          /* Navigation can dispose console argument handles. */
        }),
    );
  });
  page.on('pageerror', (error) => logs.push(error.message));
  await page.goto('/');
  await bootstrapSessionOnPage(page, account);
  const enableDiagnostics = () =>
    page.evaluate(async () => {
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      useNostrStore().setDeveloperDiagnosticsEnabled(true);
    });
  await enableDiagnostics();
  const group = await createGroup(page, { name: 'Key exposure regression', about: '' });
  await enableDiagnostics();
  await navigateToChat(page, group);
  const message = `private-message-canary-${Date.now()}`;
  await sendMessage(page, message, { chatId: group });
  await waitForThreadMessage(page, message, { chatId: group });

  await reloadAndWaitForApp(page);
  await enableDiagnostics();
  await navigateToChat(page, group);
  await waitForThreadMessage(page, message, { chatId: group });

  const recipientKey = generateSecretKey();
  const recipient = getPublicKey(recipientKey);
  const roomSecret = Buffer.from(generateSecretKey()).toString('hex');
  const callIds = await page.evaluate(
    async ({ recipient, roomSecret, sender }) => {
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      const { CALL_PROTOCOL } = await import('/src/types/call.ts');
      const { ROOM_PROTOCOL } = await import('/src/types/callRoom.ts');
      const store = useNostrStore();
      const callId = crypto.randomUUID();
      const roomId = crypto.randomUUID();
      const senderSession = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      await store.sendCallSignal(recipient, {
        protocol: CALL_PROTOCOL,
        action: 'invite',
        callId,
        expiresAt,
        mode: 'audio',
        address: { id: 'a'.repeat(64), relayUrl: 'https://call-relay.invalid/' },
        mimeType: 'audio/webm;codecs=opus',
      });
      await store.sendRoomSignal(
        recipient,
        {
          protocol: ROOM_PROTOCOL,
          action: 'join',
          roomId,
          senderSession,
          expiresAt,
          secret: roomSecret,
          member: {
            pubkey: sender,
            sessionId: senderSession,
            name: 'Generated caller',
            relays: ['ws://127.0.0.1:7777/'],
          },
        },
        ['ws://127.0.0.1:7777/'],
      );
      return [callId, roomId];
    },
    { recipient, roomSecret, sender },
  );

  const snapshot = await page.evaluate(async (group) => {
    const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
    const { chatDataService } = await import('/src/services/chatDataService.ts');
    const { contactsService } = await import('/src/services/contactsService.ts');
    const { diagnosticJson } = await import('/src/utils/diagnosticExport.ts');
    const store = useNostrStore();
    return {
      contact: await contactsService.getContactByPublicKey(group),
      chat: await chatDataService.getChatByPublicKey(group),
      diagnostics: diagnosticJson(await store.getDeveloperDiagnosticsSnapshot()),
      traces: JSON.stringify(await store.listDeveloperTraceEntries()),
    };
  }, group);
  // Recover the generated fixtures outside the app to check both real secret
  // values and that persisted group keys really are NIP-44 ciphertext.
  const key = Uint8Array.from(Buffer.from(account.privateKey, 'hex'));
  const conversationKey = nip44.v2.utils.getConversationKey(key, getPublicKey(key));
  const identity = JSON.parse(
    nip44.v2.decrypt(snapshot.contact!.meta.group_private_key_encrypted as string, conversationKey),
  );
  const epochs = snapshot.chat!.meta.group_epoch_keys as Array<{
    epoch_private_key_encrypted: string;
  }>;
  expect(epochs.length).toBeGreaterThan(0);
  const secrets = [
    account.privateKey,
    identity.group_privkey,
    ...epochs.map((epoch) => nip44.v2.decrypt(epoch.epoch_private_key_encrypted, conversationKey)),
  ];
  expect(secrets.every((secret) => /^[0-9a-f]{64}$/.test(secret))).toBe(true);
  const encodings = secrets.flatMap((secret) => [
    secret,
    nip19.nsecEncode(Uint8Array.from(Buffer.from(secret, 'hex'))),
    Buffer.from(secret, 'hex').toString('base64'),
  ]);
  if (identity.recovery_entropy) encodings.push(identity.recovery_entropy);
  encodings.push(roomSecret, ...callIds);
  const received = new Map<string, ReturnType<typeof nip59.unwrapEvent>>();
  for (const frame of outbound.filter((value) => value.startsWith('["EVENT",'))) {
    const event = JSON.parse(frame)[1];
    if (
      event.kind !== 1059 ||
      !event.tags.some((tag: string[]) => tag[0] === 'p' && tag[1] === recipient)
    )
      continue;
    received.set(event.id, nip59.unwrapEvent(event, recipientKey));
  }
  expect(received.size).toBe(2);
  const controls = [...received.values()].map((rumor) => {
    expect(rumor.kind).toBe(21117);
    expect(rumor.pubkey).toBe(sender);
    return JSON.parse(rumor.content);
  });
  expect(controls).toContainEqual(
    expect.objectContaining({ action: 'invite', callId: callIds[0] }),
  );
  expect(controls).toContainEqual(
    expect.objectContaining({ action: 'join', roomId: callIds[1], secret: roomSecret }),
  );
  await Promise.all(consoleSnapshots);
  const observed = [outbound.join('\n'), logs.join('\n'), snapshot.diagnostics, snapshot.traces];
  expect(outbound.some((frame) => frame.startsWith('["EVENT",'))).toBe(true);
  for (const surface of observed) {
    expect(encodings.some((secret) => surface.includes(secret))).toBe(false);
    expect(surface.includes(message)).toBe(false);
  }
  const persistedGroup = JSON.stringify([snapshot.contact, snapshot.chat]);
  expect(encodings.some((secret) => persistedGroup.includes(secret))).toBe(false);
});
