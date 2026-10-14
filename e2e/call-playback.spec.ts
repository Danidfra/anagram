import { expect, test } from '@playwright/test';

for (const kind of ['audio', 'video'] as const) {
  test(`${kind} playback catches up after a brief interruption without a seek loop`, async ({
    page,
  }) => {
    // Exercise the real encoder/decoder locally, without relay or device variability.
    await page.route('**/__call-playback-probe', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<button>Start media</button>' }),
    );
    await page.goto('/__call-playback-probe');
    await page.getByRole('button').click();
    const result = await page.evaluate(async (kind) => {
      const { createCallMediaReceiver, recordCallMedia } =
        await import('/src/services/callMediaService.ts');
      const { followCallLive } = await import('/src/services/callPlaybackService.ts');
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const errors: string[] = [];
      const element = document.createElement(kind);
      element.muted = true;
      document.body.append(element);
      element.onprogress = () => followCallLive(element);
      element.onerror = () => errors.push(element.error?.message || 'media error');
      let seeks = 0;
      element.onseeking = () => seeks++;
      let context: AudioContext | undefined;
      let oscillator: OscillatorNode | undefined;
      let draw: ReturnType<typeof setInterval> | undefined;
      let stream: MediaStream;
      if (kind === 'audio') {
        context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        oscillator = context.createOscillator();
        oscillator.connect(destination);
        oscillator.start();
        await context.resume();
        stream = destination.stream;
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const paint = canvas.getContext('2d')!;
        draw = setInterval(() => {
          paint.fillStyle = `hsl(${performance.now() % 360},70%,50%)`;
          paint.fillRect(0, 0, canvas.width, canvas.height);
        }, 1000 / 24);
        stream = canvas.captureStream(24);
      }
      const receiver = createCallMediaReceiver(
        kind === 'audio' ? 'audio/webm;codecs=opus' : 'video/webm;codecs=vp8',
        () => errors.push('receiver error'),
      );
      element.src = receiver.url;
      let chunk = 0;
      const stop = recordCallMedia(
        stream,
        kind === 'audio' ? 'audio/webm;codecs=opus' : 'video/webm;codecs=vp8',
        async (bytes: Uint8Array) => {
          // Small, ordered delivery jitter; retain every continuous WebM segment.
          await delay([0, 25, 70, 10][chunk++ % 4]);
          receiver.append(bytes.subarray(1));
        },
        () => errors.push('recorder error'),
      );
      try {
        void element.play().catch((error: Error) => errors.push(error.message));
        const deadline = performance.now() + 10000;
        while (element.currentTime < 1 && performance.now() < deadline) await delay(50);
        if (element.currentTime < 1) throw new Error('Media did not start playing');
        const before = seeks;
        element.pause();
        await delay(750);
        await element.play();
        await delay(1000);
        const start = element.currentTime;
        const lags: number[] = [];
        for (let i = 0; i < 20; i++) {
          await delay(100);
          lags.push(element.buffered.end(element.buffered.length - 1) - element.currentTime);
        }
        lags.sort((a, b) => a - b);
        return {
          errors,
          seeks: seeks - before,
          lag: lags[10],
          advanced: element.currentTime - start,
        };
      } finally {
        stop();
        stream.getTracks().forEach((track) => track.stop());
        clearInterval(draw);
        oscillator?.stop();
        await context?.close();
        element.pause();
        receiver.close();
        element.remove();
      }
    }, kind);
    expect(result.errors).toEqual([]);
    expect(result.seeks).toBeGreaterThan(0);
    expect(result.seeks).toBeLessThanOrEqual(3);
    expect(result.lag).toBeLessThan(0.75);
    expect(result.advanced).toBeGreaterThan(1.5);
  });
}
