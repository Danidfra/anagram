/** Observe speech without rerouting playback or changing the selected speaker. */
let shared: { context: AudioContext; observers: number } | undefined;

export function observeCallActivity(
  stream: MediaStream,
  report: (level: number) => void
): () => void {
  if (typeof AudioContext === 'undefined' || !stream.getAudioTracks().length) return () => {};
  // Packet audio is 48 kHz. One meter context avoids a separate native audio
  // engine (and sample-rate conversion) for every participant in a group.
  const current = shared ??= { context: new AudioContext({ sampleRate: 48000 }), observers: 0 };
  const { context } = current;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    source.connect(analyser);
  } catch (error) {
    source?.disconnect();
    if (!current.observers) {
      shared = undefined;
      void context.close();
    }
    throw error;
  }
  current.observers++;
  analyser.fftSize = 512;
  const samples = new Float32Array(analyser.fftSize);
  void context.resume().catch(() => {});
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    const power = samples.reduce((sum, value) => sum + value * value, 0) / samples.length;
    report(Math.sqrt(power));
  }, 100);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    source.disconnect();
    analyser.disconnect();
    if (--current.observers === 0) {
      shared = undefined;
      void context.close();
    }
    report(0);
  };
}
