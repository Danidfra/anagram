import { test, expect } from '@playwright/test';

for (const variant of [
  { agent: 'Android', room: false },
  { agent: 'iPhone', room: false },
  { agent: 'Android', room: true },
  { agent: 'iPhone', room: true },
]) {
  const { agent, room } = variant;
  test(`${agent} ${room ? 'group' : 'direct'} call controls default to receiver and explicitly select loudspeaker`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.evaluate(async ({ agent, room }) => {
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
        videoAvailable: true,
      };
      calls.localStream = new MediaStream();
      if (room) {
        const { useCallRoomStore } = await import('/src/stores/callRoomStore.ts');
        const rooms = useCallRoomStore();
        const own = { pubkey: 'b'.repeat(64), sessionId: 'local', name: 'You', relays: [] };
        rooms.session = {
          own,
          members: [own],
          phase: 'active',
          revision: 1,
          link: {
            id: 'mobile-room',
            host: own.pubkey,
            secret: '',
            relays: [],
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        };
        rooms.localStream = new MediaStream();
        rooms.cameraMuted = true;
      }
      (window as any).__releaseAudio = await acquireMobileCallAudio();
      const target = document.createElement('div');
      document.body.append(target);
      mount(CallOverlay, { target });
    }, variant);
    const prefix = room ? 'room' : 'call';
    const loudspeaker = page.getByTestId(`${prefix}-loudspeaker`);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 844 });
      const ids = ['microphone', 'loudspeaker', 'camera', 'more'];
      const boxes = await Promise.all(
        ids.map((id) => page.getByTestId(`${prefix}-${id}`).boundingBox()),
      );
      for (const box of boxes) {
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.y).toBeCloseTo(boxes[0]!.y, 0);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
      for (let i = 1; i < boxes.length; i++)
        expect(boxes[i]!.x).toBeGreaterThan(boxes[i - 1]!.x + boxes[i - 1]!.width);
      const hangup = page.getByTestId(room ? 'room-leave' : 'call-hangup');
      await expect(hangup).toBeInViewport();
      const end = (await hangup.boundingBox())!;
      expect(end.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height);
      expect(end.x + end.width / 2).toBeCloseTo(width / 2, 0);
      await expect(page.getByTestId(`${prefix}-open-controls`)).toBeHidden();
      await expect(page.getByTestId(`${prefix}-microphone-menu`)).toBeHidden();
      await page.screenshot({ path: `test-results/${agent}-${prefix}-${width}-controls.png` });
    }
    await page.getByTestId(`${prefix}-more`).click();
    await expect(page.getByTestId(`${prefix}-more`)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId(`${prefix}-speaker`)).toBeVisible();
    await page.getByTestId(`${prefix}-speaker`).click();
    await expect(page.getByTestId(`${prefix}-speaker`)).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId(`${prefix}-microphone-menu`).click();
    await expect(page.getByTestId(`${prefix}-microphone-default`)).toBeVisible();
    const menu = await page.locator('[data-call-device-menu]').boundingBox();
    expect(menu!.x).toBeGreaterThanOrEqual(0);
    expect(menu!.x + menu!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape');
    await page.getByTestId(`${prefix}-more`).click();
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
