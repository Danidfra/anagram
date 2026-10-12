import { expect, test } from '@playwright/test';
import { getPublicKey, nip19, nip44 } from 'nostr-tools';
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
test('private login and group messaging keep keys out of traffic, logs and diagnostics', async ({
  page,
}) => {
  const account = TEST_ACCOUNTS.keyExposure;
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
