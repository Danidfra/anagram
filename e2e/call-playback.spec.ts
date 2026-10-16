import { expect, test, type ConsoleMessage } from '@playwright/test';

for (const kind of ['audio', 'video'] as const) {
  for (const managed of [false, true]) {
    test(`${kind} ${managed ? 'managed' : 'standard'} playback catches up after a brief interruption without a seek loop`, async ({
      page,
      browserName,
    }, testInfo) => {
      // Exercise the real encoder/decoder locally, without relay or device variability.
      await page.route('**/__call-playback-probe', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<button>Start media</button>' }),
      );
      await page.goto('/__call-playback-probe');
      await page.getByRole('button').click();
      if (managed && browserName === 'webkit') {
        // The Apple CI job must exercise real managed playback, not the alias
        // used to cover the fallback branch in local Chromium regressions.
        expect(await page.evaluate(() => typeof (globalThis as any).ManagedMediaSource)).toBe(
          'function',
        );
      }
      // Keep progress outside the page: a native media hang can also stop its timers.
      const diagnostics: string[] = [];
      const onConsole = (message: ConsoleMessage) => {
        if (message.text().startsWith('[call-playback]')) diagnostics.push(message.text());
      };
      page.on('console', onConsole);
      const playback = page.evaluate(
        async ({ kind, managed }) => {
          const stage = (name: string) =>
            console.log(`[call-playback] ${performance.now().toFixed(0)} ${name}`);
          stage('setup');
          if (managed) {
            (window as any).isTauri = true;
            Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
            // WebKit uses its real ManagedMediaSource. Chromium exercises the same
            // fallback with its real decoder, without pretending this is an iPhone.
            const globals = globalThis as typeof globalThis & {
              ManagedMediaSource?: typeof MediaSource;
            };
            globals.ManagedMediaSource ??= MediaSource;
            Object.defineProperty(globalThis, 'MediaSource', {
              configurable: true,
              value: undefined,
            });
          }
          const { createCallMediaReceiver, recordCallMedia } =
            await import('/src/services/callMediaService.ts');
          const { watchCallLive } = await import('/src/services/callPlaybackService.ts');
          const { CALL_VIDEO_MIME_TYPE } = await import('/src/utils/callSignal.ts');
          const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
          const errors: string[] = [];
          stage('modules loaded');
          const element = document.createElement(kind);
          if (managed) element.disableRemotePlayback = true;
          if (element instanceof HTMLVideoElement) element.playsInline = true;
          element.muted = true;
          document.body.append(element);
          // Recover even if a stalled WebView emits neither progress nor timeupdate.
          const stopFollowing = watchCallLive(element);
          element.onerror = () => errors.push(element.error?.message || 'media error');
          let seeks = 0;
          element.onseeking = () => seeks++;
          let displayedFrames = 0;
          let frameCallback = 0;
          if (element instanceof HTMLVideoElement) {
            const displayed = () => {
              displayedFrames++;
              frameCallback = element.requestVideoFrameCallback(displayed);
            };
            frameCallback = element.requestVideoFrameCallback(displayed);
          }
          let context: AudioContext | undefined;
          let oscillator: OscillatorNode | undefined;
          let draw: ReturnType<typeof setInterval> | undefined;
          let canvas: HTMLCanvasElement | undefined;
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
            canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 360;
            document.body.append(canvas);
            const paint = canvas.getContext('2d')!;
            draw = setInterval(() => {
              paint.fillStyle = `hsl(${performance.now() % 360},70%,50%)`;
              paint.fillRect(0, 0, canvas!.width, canvas!.height);
            }, 1000 / 24);
            stage('canvas capture');
            stream = canvas.captureStream(24);
            stage('canvas captured');
          }
          const mime = kind === 'audio' ? 'audio/webm;codecs=opus' : CALL_VIDEO_MIME_TYPE;
          stage('create receiver');
          const receiver = createCallMediaReceiver(mime, () => errors.push('receiver error'));
          element.src = receiver.url;
          let chunk = 0;
          stage('start recorder');
          const stop = recordCallMedia(
            stream,
            mime,
            async (bytes: Uint8Array) => {
              // Small, ordered delivery jitter; retain every continuous WebM segment.
              await delay([0, 25, 70, 10][chunk++ % 4]);
              if (chunk === 1) stage('append first segment');
              receiver.append(bytes.subarray(1));
              if (chunk === 1) stage('first segment appended');
            },
            () => errors.push('recorder error'),
          );
          stage('recorder started');
          const snapshot = () => ({
            kind,
            managed,
            mime,
            chunk,
            errors,
            currentTime: element.currentTime,
            paused: element.paused,
            readyState: element.readyState,
            buffered: Array.from({ length: element.buffered.length }, (_, i) => [
              element.buffered.start(i),
              element.buffered.end(i),
            ]),
          });
          const waitForPlayback = async (after: number) => {
            const deadline = performance.now() + 10000;
            while (
              (element.paused || element.currentTime <= after) &&
              performance.now() < deadline
            ) {
              if (errors.length) throw new Error(JSON.stringify(snapshot()));
              await delay(50);
            }
            if (element.paused || element.currentTime <= after)
              throw new Error(`Media did not advance: ${JSON.stringify(snapshot())}`);
          };
          try {
            stage('start playback');
            void element.play().catch((error: Error) => errors.push(error.message));
            await waitForPlayback(1);
            stage('playback started');
            const before = seeks;
            stage('pause playback');
            element.pause();
            await delay(750);
            stage('resume playback');
            const pausedAt = element.currentTime;
            // WebKit can leave play() pending even while its native sink plays.
            // Check actual playback progress with a deadline, as the packaged probe does.
            void element.play().catch((error: Error) => errors.push(error.message));
            await waitForPlayback(pausedAt + 0.25);
            stage('playback resumed');
            await delay(1000);
            const start = element.currentTime;
            const framesBefore = displayedFrames;
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
              displayedFrames: displayedFrames - framesBefore,
            };
          } finally {
            stopFollowing();
            if (element instanceof HTMLVideoElement)
              element.cancelVideoFrameCallback(frameCallback);
            stage(`stop recorder: ${JSON.stringify(snapshot())}`);
            stop();
            stage('stop capture');
            stream.getTracks().forEach((track) => track.stop());
            clearInterval(draw);
            oscillator?.stop();
            await context?.close();
            element.pause();
            stage('close receiver');
            receiver.close();
            element.remove();
            canvas?.remove();
            stage('cleanup complete');
          }
        },
        { kind, managed },
      );
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        playback,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error(
                  `Media probe stopped responding. Last stages:\n${diagnostics.join('\n')}`,
                ),
              ),
            30000,
          );
        }),
      ]).finally(async () => {
        clearTimeout(deadline);
        page.off('console', onConsole);
        await testInfo.attach('playback-diagnostics', {
          body: diagnostics.join('\n'),
          contentType: 'text/plain',
        });
      });
      expect(result.errors).toEqual([]);
      // Browsers may catch up themselves; require low lag and sustained playback,
      // not an unnecessary application seek. Unit tests exercise forced drift.
      expect(result.seeks).toBeLessThanOrEqual(3);
      expect(result.lag).toBeLessThan(0.75);
      expect(result.advanced).toBeGreaterThan(1.5);
      if (kind === 'video') expect(result.displayedFrames).toBeGreaterThan(5);
    });
  }
}
