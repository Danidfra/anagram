import { expect, test } from '@playwright/test';

for (const nativeAck of [false, true]) {
  test(`Opus worker and AudioWorklet play decoded audio through loss, jitter and a relay stall (native acknowledgements: ${nativeAck})`, async ({
    page,
  }, info) => {
    await page.route('**/__packet-audio', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<button>Start</button>' }),
    );
    await page.goto('/__packet-audio');
    await page.evaluate(async (nativeAck) => {
      const { prepareCallPacketAudio, recordCallMedia, createCallMediaReceiver } =
        await import('/src/services/callMediaService.ts');
      const { OPUS_CALL_MIME } = await import('/src/services/callAudioPackets.ts');
      const { attachCallMedia, getCallStream } =
        await import('/src/services/callStreamRegistry.ts');
      const { callPacketAudioDiagnostics } = await import('/src/services/callPacketAudio.ts');
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const run = async () => {
        const context = new AudioContext();
        const monitorContext = new AudioContext();
        const resumed = Promise.all([context.resume(), monitorContext.resume()]);
        const release = await prepareCallPacketAudio();
        if (!release) throw new Error('Packet audio unavailable');
        await resumed;
        const destination = context.createMediaStreamDestination();
        const tone = context.createOscillator();
        tone.frequency.value = 440;
        tone.connect(destination);
        tone.start();
        const errors: string[] = [];
        const receiver = createCallMediaReceiver(OPUS_CALL_MIME, () => errors.push('decoder'));
        const audio = document.createElement('audio');
        document.body.append(audio);
        attachCallMedia(audio, receiver.url);
        const analyser = monitorContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        const silent = monitorContext.createGain();
        silent.gain.value = 0;
        monitorContext
          .createMediaStreamSource(getCallStream(receiver.url)!)
          .connect(analyser)
          .connect(silent)
          .connect(monitorContext.destination);
        const spectrum = new Float32Array(analyser.frequencyBinCount);
        let count = 0,
          stall = false;
        const timers = new Set<ReturnType<typeof setTimeout>>();
        let inFlight = 0,
          maxInFlight = 0;
        const recordingAt = performance.now();
        const stop = recordCallMedia(
          destination.stream,
          OPUS_CALL_MIME,
          async (frame) => {
            const n = count++;
            if (n % 19 === 0) return; // deterministic packet loss
            const ms = stall ? 650 : [0, 10, 30, 5][n % 4];
            const timer = setTimeout(() => {
              timers.delete(timer);
              receiver.append(frame);
            }, ms);
            timers.add(timer);
            if (nativeAck) {
              maxInFlight = Math.max(maxInFlight, ++inFlight);
              await delay(35);
              inFlight--;
            }
          },
          () => errors.push('encoder'),
        );
        const timings: number[] = [];
        try {
          await audio.play();
          await delay(1000);
          for (let i = 0; i < 6; i++) {
            if (i === 2) {
              stall = true;
              await delay(500);
              stall = false;
              await delay(900);
            }
            if (i === 4) {
              // The audio render/codec threads keep running during a UI stall.
              // Recovery must discard old encoded deliveries instead of replaying them.
              const until = performance.now() + 250;
              while (performance.now() < until) {
                /* simulate a blocked UI thread */
              }
              await delay(500);
            }
            const frequency = i % 2 ? 440 : 880;
            const other = i % 2 ? 880 : 440;
            const bin = (hz: number) =>
              Math.round((hz * analyser.fftSize) / monitorContext.sampleRate);
            const start = performance.now();
            tone.frequency.setValueAtTime(frequency, context.currentTime);
            let detected = false;
            while (performance.now() - start < 2000) {
              analyser.getFloatFrequencyData(spectrum);
              if (
                spectrum[bin(frequency)] > -45 &&
                spectrum[bin(frequency)] > spectrum[bin(other)] + 8
              ) {
                detected = true;
                break;
              }
              await delay(5);
            }
            if (!detected)
              throw new Error(
                `No decoded ${frequency} Hz audio; errors=${errors} count=${count} time=${audio.currentTime} stats=${JSON.stringify(callPacketAudioDiagnostics())} max=${Math.max(...spectrum)}`,
              );
            timings.push(performance.now() - start);
            await delay(150);
          }
          return {
            timings,
            errors,
            packets: count,
            maxInFlight,
            rate: (count * 1000) / (performance.now() - recordingAt),
            stats: callPacketAudioDiagnostics(),
          };
        } finally {
          stop();
          timers.forEach(clearTimeout);
          receiver.close();
          release();
          audio.pause();
          audio.srcObject = null;
          tone.stop();
          destination.stream.getTracks().forEach((track) => track.stop());
          await Promise.all([context.close(), monitorContext.close()]);
        }
      };
      document.querySelector('button')!.onclick = () => {
        (window as any).__packetResult = run();
      };
    }, nativeAck);
    await page.getByRole('button').click();
    const result = await page.evaluate(() => (window as any).__packetResult);
    console.log('[packet audio]', JSON.stringify(result));
    await info.attach('packet-audio.json', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    expect(result.errors).toEqual([]);
    expect(result.packets).toBeGreaterThan(100);
    expect(Math.max(...result.timings)).toBeLessThan(400);
    if (nativeAck) {
      expect(result.maxInFlight).toBe(2);
      expect(result.rate).toBeGreaterThan(35);
    }
  });
}
