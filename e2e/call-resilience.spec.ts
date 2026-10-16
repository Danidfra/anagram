import { expect, test, chromium } from '@playwright/test';

for (const kind of ['direct', 'group'] as const)
  test(`real Iroh ${kind} calls recover a broken connection without recapturing audio`, async ({
    baseURL,
  }) => {
    test.skip(process.env.ANAGRAM_LIVE_CALL_TEST !== '1', 'Requires the local Iroh relay');
    const browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'],
    });
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      await page.goto(baseURL!);
      const result = await page.evaluate(async (kind) => {
        const { createCallRuntime } = await import('/src/stores/nostr/callRuntime.svelte.ts');
        const { createCallRoomRuntime } =
          await import('/src/stores/nostr/callRoomRuntime.svelte.ts');
        const { createIrohCallEndpoint } = await import('/src/services/irohCallTransport.ts');
        const { recordCallMedia, createCallMediaReceiver } =
          await import('/src/services/callMediaService.ts');
        const { followCallLive } = await import('/src/services/callPlaybackService.ts');
        const wait = async (check: () => boolean, description: string) => {
          const end = performance.now() + 20000;
          while (!check()) {
            if (performance.now() > end) throw new Error(description);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        };
        const ids = ['a'.repeat(64), 'b'.repeat(64)];
        const calls: any[] = [],
          connections: any[][] = [[], []];
        const captures = [0, 0],
          received = [0, 0],
          multiplexed = [false, false];
        const audioContext = new AudioContext();
        const oscillators: OscillatorNode[] = [],
          elements: HTMLAudioElement[] = [];
        await audioContext.resume();
        for (let i = 0; i < 2; i++) {
          const media = {
            getOwnPubkey: () => ids[i],
            resolvePeer: async () => ({ name: 'Peer' }),
            supported: () => true,
            sendSignal: async (_: string, signal: any) => {
              await calls[1 - i].receiveSignal(ids[i], signal);
            },
            getMedia: async () => {
              captures[i]++;
              const oscillator = audioContext.createOscillator();
              const output = audioContext.createMediaStreamDestination();
              oscillator.connect(output);
              oscillator.start();
              oscillators.push(oscillator);
              return output.stream;
            },
            createEndpoint: async () => {
              const endpoint = await createIrohCallEndpoint(['https://127.0.0.1:7004/']);
              const wrap = (connection: any) => {
                connections[i].push(connection);
                return connection;
              };
              return {
                ...endpoint,
                connect: async (...args: any[]) => {
                  multiplexed[i] = args[3] === true;
                  return wrap(await endpoint.connect(...args));
                },
                accept: async (...args: any[]) => {
                  multiplexed[i] = args[2] === true;
                  return wrap(await endpoint.accept(...args));
                },
              };
            },
            record: recordCallMedia,
            createReceiver: (mime: string, onError: () => void) => {
              const receiver = createCallMediaReceiver(mime, onError);
              const audio = document.createElement('audio');
              audio.muted = true;
              audio.autoplay = true;
              audio.src = receiver.url;
              audio.ontimeupdate = audio.onprogress = () => followCallLive(audio);
              document.body.append(audio);
              elements.push(audio);
              void audio.play().catch(() => {});
              return {
                ...receiver,
                append: (bytes: Uint8Array) => {
                  received[i]++;
                  receiver.append(bytes);
                },
                close: () => {
                  receiver.close();
                  audio.pause();
                  audio.remove();
                },
              };
            },
          };
          calls.push(
            kind === 'direct'
              ? createCallRuntime(media)
              : createCallRoomRuntime({
                  media,
                  getOwnPubkey: () => ids[i],
                  isBlocked: () => false,
                  otherCallBusy: () => false,
                  getIdentity: async () => ({
                    name: `Peer ${i}`,
                    relays: ['ws://127.0.0.1:7777/'],
                  }),
                  send: async (_: string, signal: any) => {
                    await calls[1 - i].receive(ids[i], signal);
                  },
                }),
          );
        }
        const active = () =>
          calls.every(
            (call, i) =>
              call.session?.phase === 'active' &&
              (kind === 'direct' ||
                call.participants.find((peer: any) => peer.pubkey === ids[1 - i])?.phase ===
                  'active'),
          );
        try {
          if (kind === 'direct') {
            await calls[0].start(ids[1], 'audio');
            await calls[1].accept();
          } else {
            await calls[0].create();
            await calls[1].join(calls[0].session.link);
          }
          await wait(
            () => active() && received.every((count) => count > 5),
            'Initial media did not arrive',
          );
          const started = calls.map((call) => call.session.startedAt);
          calls[0].toggleMicrophone();
          for (let interruption = 0; interruption < 3; interruption++) {
            connections[0][interruption].close('failed');
            await wait(
              () => connections.every((list) => list.length === interruption + 2) && active(),
              'Call did not recover',
            );
            const after = [...received];
            await wait(
              () => received.every((count, i) => count > after[i] + 5),
              'Recovered connection carries no audio',
            );
            await wait(
              () => elements.slice(-2).every((audio) => audio.currentTime > 0.5),
              'Recovered audio did not play',
            );
          }
          return {
            captures,
            multiplexed,
            sameStart: calls.every((call, i) => call.session.startedAt === started[i]),
            muted: kind === 'direct' ? calls[0].session.microphoneMuted : calls[0].microphoneMuted,
            rosterIntact:
              kind === 'direct' || calls.every((call) => call.session.members.length === 2),
            phases: calls.map((call) => call.session.phase),
          };
        } finally {
          calls.forEach((call) => call.reset());
          oscillators.forEach((oscillator) => oscillator.stop());
          await audioContext.close();
          elements.forEach((element) => element.remove());
        }
      }, kind);
      expect(result).toEqual({
        captures: [1, 1],
        multiplexed: [true, true],
        sameStart: true,
        muted: true,
        rosterIntact: true,
        phases: ['active', 'active'],
      });
    } finally {
      await browser.close();
    }
  });
