// Loaded only by run.mjs, inside the real Tauri WebView (or Chromium for harness checks).
import { isTauri } from '@tauri-apps/api/core';
import { createCallRuntime } from '/src/stores/nostr/callRuntime.svelte.ts';
import { createCallRoomRuntime } from '/src/stores/nostr/callRoomRuntime.svelte.ts';
import { createIrohCallEndpoint } from '/src/services/irohCallTransport.ts';
import {
  callMediaSupported,
  recordCallMedia,
  createCallMediaReceiver,
} from '/src/services/callMediaService.ts';
import { watchCallLive } from '/src/services/callPlaybackService.ts';

const token = new URL(location.href).searchParams.get('token');
const report = async (data) => {
  document.querySelector('pre').textContent = JSON.stringify(data, null, 2);
  await fetch(`/__native_calls/report?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const wait = async (check, description) => {
  const deadline = performance.now() + 30000;
  while (!check()) {
    assert(performance.now() < deadline, description);
    await delay(100);
  }
};

async function scenario(kind, context) {
  const count = kind === 'direct' ? 2 : 4;
  const ids = Array.from({ length: count }, (_, i) => (i + 10).toString(16).repeat(64));
  const calls = [],
    connections = ids.map(() => []),
    players = new Set();
  const captures = ids.map(() => 0),
    cleanup = [],
    errors = [];
  let stopping = false;
  const snapshot = () => ({
    kind,
    phases: calls.map((c) => c.session?.phase),
    errors,
    connections: connections.map((c) => c.length),
    captures,
    players: [...players].map((p) => ({
      peer: p.peer,
      video: p.video,
      time: p.element.currentTime,
      frames: p.frames,
      audioSamples: p.audioSamples,
      paused: p.element.paused,
      readyState: p.element.readyState,
      chunks: p.chunks,
      buffered: Array.from({ length: p.element.buffered.length }, (_, i) => [
        p.element.buffered.start(i),
        p.element.buffered.end(i),
      ]),
    })),
  });
  const stage = (name) => report({ stage: `${kind}: ${name}`, ...snapshot() });
  const healthy = () => {
    assert(!errors.length, JSON.stringify(snapshot()));
    return (
      calls.length === count &&
      calls.every(
        (c) =>
          c.session?.phase === 'active' &&
          (kind === 'direct' ||
            (c.participants.length === count - 1 &&
              c.participants.every((p) => p.phase === 'active'))),
      )
    );
  };
  const microphone = (peer) => {
    captures[peer]++;
    const oscillator = context.createOscillator(),
      output = context.createMediaStreamDestination();
    oscillator.frequency.value = 330 + peer * 110;
    oscillator.connect(output);
    oscillator.start();
    cleanup.push(() => {
      oscillator.stop();
      output.stream.getTracks().forEach((t) => t.stop());
    });
    return output.stream;
  };
  const camera = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    // Keep sources in the window so native engines do not throttle hidden canvases.
    document.querySelector('#sources').append(canvas);
    const paint = canvas.getContext('2d');
    const draw = setInterval(() => {
      paint.fillStyle = `hsl(${performance.now() % 360},70%,50%)`;
      paint.fillRect(0, 0, canvas.width, canvas.height);
    }, 1000 / 24);
    const stream = canvas.captureStream(24);
    cleanup.push(() => {
      clearInterval(draw);
      stream.getTracks().forEach((t) => t.stop());
      canvas.remove();
    });
    return stream;
  };
  try {
    for (let i = 0; i < count; i++) {
      const media = {
        getOwnPubkey: () => ids[i],
        resolvePeer: async () => ({ name: `Peer ${i}` }),
        supported: callMediaSupported,
        sendSignal: async (to, signal) => calls[ids.indexOf(to)].receiveSignal(ids[i], signal),
        getMedia: async () => microphone(i),
        getCamera: async () => camera(),
        createEndpoint: async () => {
          const endpoint = await createIrohCallEndpoint(['https://127.0.0.1:7004/']);
          const wrap = (connection) => {
            connections[i].push(connection);
            return connection;
          };
          return {
            ...endpoint,
            connect: async (...args) => wrap(await endpoint.connect(...args)),
            accept: async (...args) => wrap(await endpoint.accept(...args)),
          };
        },
        record: recordCallMedia,
        createReceiver: (mime, onError) => {
          const failed = (message) => {
            if (!stopping) errors.push(message);
            onError();
          };
          const receiver = createCallMediaReceiver(mime, () => failed(`receiver ${i}: ${mime}`));
          const video = mime.startsWith('video/');
          const element = document.createElement(video ? 'video' : 'audio');
          element.muted = true;
          element.autoplay = true;
          if (video) element.playsInline = true;
          const player = { peer: i, video, element, frames: 0, chunks: 0, audioSamples: 0 };
          players.add(player);
          const stopFollowing = watchCallLive(element);
          let frameCallback;
          let audioTimer, audioSource, analyser, silent;
          if (video) {
            assert(
              typeof element.requestVideoFrameCallback === 'function',
              'Video frame observer unavailable',
            );
            const displayed = () => {
              player.frames++;
              frameCallback = element.requestVideoFrameCallback(displayed);
            };
            frameCallback = element.requestVideoFrameCallback(displayed);
          } else {
            // Observe decoded sound, not merely a moving playback cursor. Silence
            // the output downstream of the analyser so runners do not emit tones.
            element.muted = false;
            audioSource = context.createMediaElementSource(element);
            analyser = context.createAnalyser();
            silent = context.createGain();
            silent.gain.value = 0;
            audioSource.connect(analyser).connect(silent).connect(context.destination);
            const samples = new Float32Array(analyser.fftSize);
            audioTimer = setInterval(() => {
              analyser.getFloatTimeDomainData(samples);
              if (samples.some((sample) => Math.abs(sample) > 0.01)) player.audioSamples++;
            }, 100);
          }
          element.onerror = () => failed(`player ${i}: ${element.error?.message}`);
          document.querySelector('#players').append(element);
          element.src = receiver.url;
          void element.play().catch((e) => {
            if (!stopping && players.has(player)) errors.push(e.message);
          });
          return {
            ...receiver,
            append: (bytes) => {
              player.chunks++;
              receiver.append(bytes);
            },
            close: () => {
              players.delete(player);
              stopFollowing();
              element.onerror = null;
              if (frameCallback !== undefined) element.cancelVideoFrameCallback(frameCallback);
              clearInterval(audioTimer);
              audioSource?.disconnect();
              analyser?.disconnect();
              silent?.disconnect();
              element.pause();
              element.removeAttribute('src');
              element.load();
              element.remove();
              receiver.close();
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
              getIdentity: async () => ({ name: `Peer ${i}`, relays: ['wss://example.invalid/'] }),
              send: async (to, signal) => calls[ids.indexOf(to)].receive(ids[i], signal),
            }),
      );
    }
    await stage('starting audio');
    if (kind === 'direct') {
      await calls[0].start(ids[1], 'audio');
      await calls[1].accept();
    } else {
      await calls[0].create();
      for (let i = 1; i < count; i++) await calls[i].join(calls[0].session.link);
    }
    const lanes = count * (count - 1);
    await wait(
      () =>
        healthy() &&
        players.size === lanes &&
        [...players].every((p) => p.element.currentTime > 1 && p.audioSamples > 3),
      'Initial audio did not play',
    );
    await stage('audio playing; enabling video');
    for (const call of calls) await call.toggleCamera();
    await wait(
      () =>
        healthy() &&
        players.size === lanes * 2 &&
        [...players].every((p) => !p.video || p.frames > 5),
      'Video did not display',
    );
    const sustain = async (name) => {
      // Longer than the receiver's pruning window and Linux's keyframe renewal.
      const baseline = new Map(
        [...players].map((p) => [
          p,
          { time: p.element.currentTime, frames: p.frames, audioSamples: p.audioSamples },
        ]),
      );
      for (let sample = 0; sample < 5; sample++) {
        await delay(5000);
        assert(healthy(), `Call ended during ${name}: ${JSON.stringify(snapshot())}`);
        assert(players.size === lanes * 2, 'A media lane disappeared');
        for (const p of players) {
          const previous = baseline.get(p);
          assert(
            previous && !p.element.paused && p.element.currentTime > previous.time + 0.5,
            `Playback stalled: ${JSON.stringify(snapshot())}`,
          );
          assert(
            !p.video || p.frames > previous.frames + 2,
            `Video stopped displaying: ${JSON.stringify(snapshot())}`,
          );
          assert(
            p.video || p.audioSamples > previous.audioSamples + 3,
            `Decoded audio went silent: ${JSON.stringify(snapshot())}`,
          );
          baseline.set(p, {
            time: p.element.currentTime,
            frames: p.frames,
            audioSamples: p.audioSamples,
          });
        }
        await stage(`${name} ${5 * (sample + 1)}s`);
      }
      for (const p of players) {
        const b = p.element.buffered;
        assert(
          b.length && b.end(b.length - 1) - b.start(0) < 15,
          `Unbounded playback buffer: ${JSON.stringify(snapshot())}`,
        );
      }
    };
    await sustain('sustained audio/video');
    const started = calls.map((c) => c.session.startedAt),
      before = connections.map((c) => c.length);
    calls[0].toggleMicrophone();
    await stage('muted; disconnecting one peer connection');
    connections[0][0].close('failed');
    await wait(
      () =>
        healthy() &&
        connections[0].length > before[0] &&
        players.size === lanes * 2 &&
        [...players].every((p) => p.element.currentTime > 1 && (!p.video || p.frames > 5)),
      'Call did not recover audio/video',
    );
    assert(
      kind === 'direct' ? calls[0].session.microphoneMuted : calls[0].microphoneMuted,
      'Reconnect lost mute state',
    );
    assert(
      calls.every((c, i) => c.session.startedAt === started[i]),
      'Reconnect reset call start time',
    );
    assert(
      captures.every((n) => n === 1),
      'Reconnect recaptured microphone',
    );
    calls[0].toggleMicrophone();
    await sustain('after reconnect');
    const result = snapshot();
    await stage('hangup');
    if (kind === 'direct') await calls[0].end();
    else for (const c of calls) await c.leave();
    await wait(() => players.size === 0, 'Hangup retained media players');
    return result;
  } catch (error) {
    await report({ stage: `${kind}: failed`, error: String(error), ...snapshot() });
    throw error;
  } finally {
    stopping = true;
    calls.forEach((c) => c.reset());
    cleanup.forEach((stop) => stop());
  }
}

document.querySelector('button').onclick = async () => {
  document.querySelector('button').disabled = true;
  const context = new AudioContext();
  // Resume synchronously in the native keyboard/click gesture, before reporting.
  const resumed = context.resume();
  try {
    await report({ stage: 'started', native: isTauri(), userAgent: navigator.userAgent });
    assert(
      isTauri() === (new URL(location.href).searchParams.get('native') === '1'),
      'Wrong app/browser runtime',
    );
    await resumed;
    assert(
      callMediaSupported('audio') && callMediaSupported('video'),
      'Required call codecs unavailable',
    );
    const results = [];
    for (const kind of ['direct', 'group']) results.push(await scenario(kind, context));
    await report({
      done: true,
      passed: true,
      native: isTauri(),
      userAgent: navigator.userAgent,
      results,
    });
  } catch (error) {
    await report({ done: true, passed: false, error: String(error), stack: error?.stack });
  } finally {
    await context.close();
  }
};
await report({ stage: 'ready' });
