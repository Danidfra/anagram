import { test, expect } from '@playwright/test';

for (const agent of ['Android', 'iPhone']) {
  test(`${agent} call controls default to receiver and explicitly select loudspeaker`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.evaluate(async (agent) => {
      (window as any).isTauri = true;
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: agent });
      const writes: unknown[] = [];
      (window as any).__audioWrites = writes;
      (window as any).__TAURI_INTERNALS__ = {
        transformCallback: () => 1,
        invoke: async (command: string, args: unknown) => {
          if (command === 'set_mobile_call_audio') writes.push(args);
          return command === 'plugin:event|listen' ? 1 : null;
        },
      };
      const { mount } = await import('/src/lib/dev/mountFixture.ts');
      const { default: CallOverlay } = await import('/src/lib/components/CallOverlay.svelte');
      const { useCallStore } = await import('/src/stores/callStore.ts');
      const { acquireMobileCallAudio } = await import('/src/services/mobileCallAudio.ts');
      const calls = useCallStore();
      calls.session = {
        id: 'mobile-route',
        peerPubkey: 'a'.repeat(64),
        peerName: 'Caller',
        direction: 'outgoing',
        mode: 'audio',
        phase: 'active',
        startedAt: new Date().toISOString(),
        microphoneMuted: false,
        cameraMuted: true,
        mediaVersion: 2,
      };
      calls.localStream = new MediaStream();
      (window as any).__releaseAudio = await acquireMobileCallAudio();
      const target = document.createElement('div');
      document.body.append(target);
      mount(CallOverlay, { target });
    }, agent);
    const loudspeaker = page.getByTestId('call-loudspeaker');
    await expect(loudspeaker).toHaveAttribute('aria-pressed', 'false');
    await expect(loudspeaker).toHaveAccessibleName('Use loudspeaker');
    await loudspeaker.click();
    await expect(loudspeaker).toHaveAttribute('aria-pressed', 'true');
    await expect(loudspeaker).toHaveAccessibleName('Use earpiece or connected headset');
    await loudspeaker.click();
    await expect(loudspeaker).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(() => (window as any).__releaseAudio());
    await expect
      .poll(() => page.evaluate(() => (window as any).__audioWrites))
      .toEqual([
        { active: true, speaker: false },
        { active: true, speaker: true },
        { active: true, speaker: false },
        { active: false, speaker: false },
      ]);
  });
}
