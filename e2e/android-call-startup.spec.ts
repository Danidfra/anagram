import { test, expect } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip59 } from 'nostr-tools';

test('notification Answer reaches the matching call while startup restoration is pending', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const relays = JSON.stringify([{ url: 'ws://127.0.0.1:7777/', read: true, write: true }]);
    localStorage.setItem('relays', relays);
    localStorage.setItem('nip65_relays', relays);
  });
  await page.goto('/');
  await expect(page.getByTestId('auth-open-key-button')).toBeVisible();
  const ownerKey = generateSecretKey();
  const peerKey = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerKey);
  const peer = getPublicKey(peerKey);
  const callId = crypto.randomUUID();
  const expiresAt = Date.now() + 60_000;
  const action = {
    token: 'generated-notification-token',
    ownerPubkey,
    peer,
    callId,
    expiresAt,
    relayUrl: 'ws://127.0.0.1:7777/',
    answer: true,
    event: nip59.wrapEvent(
      {
        kind: 21117,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', ownerPubkey]],
        content: JSON.stringify({
          protocol: 'anagram/iroh-call/1',
          callId,
          action: 'invite',
          mode: 'audio',
          expiresAt: new Date(expiresAt).toISOString(),
          address: { id: 'a'.repeat(64), relayUrl: 'https://relay.example/' },
          mimeType: 'audio/webm;codecs=opus',
        }),
      },
      peerKey,
      ownerPubkey,
    ),
  };
  await page.evaluate(
    async ({ key, action }) => {
      const { useNostrStore } = await import('/src/stores/nostrStore.svelte.ts');
      const { useCallStore } = await import('/src/stores/callStore.ts');
      const { contactsService } = await import('/src/services/contactsService.ts');
      const { mount } = await import('/src/lib/dev/mountFixture.ts');
      const { default: Shell } = await import('/src/lib/components/Shell.svelte');
      const nostr = useNostrStore();
      await nostr.savePrivateKeyHex(key);
      await contactsService.createContact({
        public_key: action.peer,
        name: 'Caller',
        meta: { private_contact_list_member: true },
      });
      // Keep restoration blocked indefinitely: answering must not depend on it.
      nostr.initializeSessionState = () => new Promise(() => {});
      nostr.isRestoringStartupState = true;
      nostr.startAppLifecycleRuntime = () => {};
      nostr.publicGroups.init = async () => {};
      nostr.sendCallSignal = async () => {};
      const calls = useCallStore();
      const probe = { claimed: false, answered: null as unknown };
      (window as any).__answerProbe = probe;
      // Exercise the real signed-envelope ingestion and matching call session;
      // Android IPC and media acceptance are the two mocked device boundaries.
      calls.accept = async (mode: string) => {
        probe.answered = {
          mode,
          callId: calls.session?.id,
          restoring: nostr.isRestoringStartupState,
        };
      };
      let pending: typeof action | null = action;
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android' });
      (window as any).isTauri = true;
      (window as any).__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command: string, args: any) => {
          if (command === 'plugin:event|listen') return 1;
          if (command !== 'android_notification_command') return null;
          if (args.method === 'takeNotificationAction') {
            const value = pending;
            pending = null;
            return value;
          }
          if (args.method === 'getCallNotificationState') return { closed: [] };
          if (args.method === 'claimCallAnswer') {
            probe.claimed = args.args.token === action.token;
            return { valid: probe.claimed };
          }
          return {};
        },
      };
      const target = document.createElement('div');
      document.body.append(target);
      mount(Shell, { target });
    },
    { key: Buffer.from(ownerKey).toString('hex'), action },
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__answerProbe), { timeout: 10_000 })
    .toEqual({
      claimed: true,
      answered: { mode: 'audio', callId, restoring: true },
    });
  expect(errors).toEqual([]);
});
