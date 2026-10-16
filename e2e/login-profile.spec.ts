import { test, expect } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { finalizeEvent, generateSecretKey, matchFilters, nip19 } from 'nostr-tools';

for (const account of ['created', 'resumed', 'imported'] as const) {
  test(`${account} account handles a relay that never completes profile queries`, async ({
    page,
  }) => {
    const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => relay.once('listening', resolve));
    relay.on('connection', (socket) =>
      socket.on('message', (data) => {
        const [verb, id, ...filters] = JSON.parse(String(data));
        if (verb !== 'REQ') return;
        if (filters.some((filter: { kinds?: number[] }) => filter.kinds?.includes(0))) return;
        socket.send(JSON.stringify(['EOSE', id]));
      }),
    );
    try {
      const url = `ws://127.0.0.1:${(relay.address() as { port: number }).port}/`;
      await page.addInitScript((url) => {
        const relays = JSON.stringify([{ url, read: true, write: true }]);
        localStorage.setItem('relays', relays);
        localStorage.setItem('nip65_relays', relays);
      }, url);
      await page.goto('/');
      if (account === 'imported') {
        await page.getByTestId('auth-open-key-button').click();
        await page
          .getByTestId('auth-private-key-input')
          .fill(nip19.nsecEncode(generateSecretKey()));
        await page.getByTestId('auth-login-button').click();
      } else {
        await page.getByTestId('auth-create-account-button').click();
        await page.getByRole('button', { name: 'Login Now', exact: true }).click();
      }
      await expect(page.getByTestId('auth-onboarding-relays-next-button')).toBeEnabled();
      if (account === 'resumed') await page.reload();
      await page.getByTestId('auth-onboarding-relays-next-button').click();
      if (account === 'imported') {
        // A timed-out lookup must not assert that an existing account has no profile.
        await expect(page.getByTestId('auth-onboarding-retry-button')).toBeVisible();
        await expect(page.getByTestId('auth-onboarding-profile-start-button')).toHaveCount(0);
      } else {
        await expect(page.getByTestId('auth-onboarding-profile-start-button')).toBeVisible();
        await expect(page.getByRole('alert')).toHaveCount(0);
      }
    } finally {
      for (const socket of relay.clients) socket.terminate();
      relay.close();
    }
  });
}

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
