import { test, expect } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey, matchFilters, nip19 } from 'nostr-tools';

for (const slow of [false, true]) {
  test(`private-key login finds an existing profile${slow ? ' on a slower relay' : ''}`, async ({
    page,
  }) => {
    const key = generateSecretKey();
    const profile = finalizeEvent(
      {
        kind: 0,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: JSON.stringify({ name: 'Existing account', about: 'Already published profile' }),
      },
      key,
    );
    let connectProfileRelay: (() => void) | undefined;
    const empty = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const profiles = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      ...(slow
        ? {
            verifyClient: (_info: unknown, done: (allowed: boolean) => void) => {
              connectProfileRelay = () => {
                connectProfileRelay = undefined;
                done(true);
              };
            },
          }
        : {}),
    });
    await Promise.all(
      [empty, profiles].map(
        (server) => new Promise<void>((resolve) => server.once('listening', resolve)),
      ),
    );
    for (const server of [empty, profiles]) {
      server.on('connection', (socket) =>
        socket.on('message', (data) => {
          const [verb, id, ...filters] = JSON.parse(String(data));
          if (verb !== 'REQ') return;
          if (server === profiles && matchFilters(filters, profile))
            socket.send(JSON.stringify(['EVENT', id, profile]));
          socket.send(JSON.stringify(['EOSE', id]));
        }),
      );
    }
    try {
      const relays = [empty, profiles].map(
        (server) => `ws://127.0.0.1:${(server.address() as { port: number }).port}/`,
      );
      await page.addInitScript(
        (relays) =>
          localStorage.setItem(
            'relays',
            JSON.stringify(relays.map((url) => ({ url, read: true, write: true }))),
          ),
        relays,
      );
      await page.goto('/');
      await page.getByTestId('auth-open-key-button').click();
      await page.getByTestId('auth-private-key-input').fill(nip19.nsecEncode(key));
      await page.getByTestId('auth-login-button').click();
      const next = page.getByTestId('auth-onboarding-relays-next-button');
      if (slow) {
        await expect.poll(() => Boolean(connectProfileRelay)).toBe(true);
        // A fast empty relay must not let the profile relay disappear from lookup.
        await expect(next).toBeEnabled();
        await next.click();
        connectProfileRelay!();
      } else await next.click();
      await expect(page.locator('.onboarding .profile')).toContainText('Existing account');
      await expect(page.locator('.onboarding .profile')).toContainText('Already published profile');
      await expect(page.getByTestId('auth-onboarding-profile-start-button')).toHaveCount(0);
    } finally {
      connectProfileRelay?.();
      for (const server of [empty, profiles]) {
        for (const socket of server.clients) socket.terminate();
        server.close();
      }
    }
  });
}
