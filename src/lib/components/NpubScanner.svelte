<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { translate } from '#src/i18n.ts';
  import { nip19 } from '#src/lib/nostr/client.ts';

  export let onscan: (npub: string) => void;
  export let oncancel: () => void;
  let video: HTMLVideoElement;
  let stream: MediaStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let disposed = false;
  let error = '';
  let status = 'qr.opening';
  let opening = false;
  let cameras: MediaDeviceInfo[] = [];
  let cameraId = '';
  let facing: 'environment' | 'user' = 'environment';

  async function switchCamera() {
    if (opening) return;
    const index = cameras.findIndex((device) => device.deviceId === cameraId);
    facing = facing === 'environment' ? 'user' : 'environment';
    await start(cameras.length > 1 ? cameras[(index + 1) % cameras.length].deviceId : '');
  }

  function stop() {
    generation++;
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    if (video) video.srcObject = null;
  }
  function fail(cause: unknown) {
    stop();
    opening = false;
    const name = cause instanceof Error ? cause.name : '';
    error =
      name === 'NotAllowedError' || name === 'SecurityError'
        ? 'qr.denied'
        : name === 'NotFoundError'
          ? 'qr.noCamera'
          : 'qr.failed';
  }
  async function start(deviceId = '') {
    stop();
    error = '';
    status = 'qr.opening';
    opening = true;
    const current = generation;
    const cancelled = () => disposed || current !== generation;
    if (!navigator.mediaDevices?.getUserMedia) {
      error = 'qr.unavailable';
      opening = false;
      return;
    }
    try {
      // Load only when scanning; decode locally in every WebView, without
      // depending on the optional BarcodeDetector browser API.
      const { default: decode } = await import('jsqr');
      if (cancelled()) return;
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facing } }),
          width: { ideal: 1280 },
        },
      });
      // Closing while the permission prompt is open must not leave a camera on.
      if (cancelled()) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      const settings = acquired.getVideoTracks()[0]?.getSettings();
      cameraId = settings?.deviceId || deviceId;
      if (settings?.facingMode === 'user' || settings?.facingMode === 'environment')
        facing = settings.facingMode;
      // Enumerate after permission so iOS can expose camera IDs. Failure must
      // not prevent scanning with the camera we already have.
      void navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (cancelled()) return;
          cameras = devices.filter(
            (device, index) =>
              device.kind === 'videoinput' &&
              device.deviceId &&
              devices.findIndex(
                (other) => other.kind === device.kind && other.deviceId === device.deviceId,
              ) === index,
          );
        })
        .catch(() => {});
      video.srcObject = stream;
      void video.play().catch((cause) => {
        if (!cancelled()) fail(cause);
      });
      status = 'qr.point';
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Camera frames are unavailable');
      function scan() {
        if (cancelled()) return;
        try {
          if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
            const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            context!.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixels = context!.getImageData(0, 0, canvas.width, canvas.height);
            const code = decode(pixels.data, pixels.width, pixels.height);
            if (code) {
              let npub = '';
              try {
                const value = code.data.trim().replace(/^nostr:/i, '');
                const decoded = nip19.decode(value);
                if (decoded.type === 'npub' && /^[a-f0-9]{64}$/.test(decoded.data))
                  npub = nip19.npubEncode(decoded.data);
              } catch {
                // Ignore unrelated/malformed QR codes; keep the camera ready.
              }
              if (npub) {
                stop();
                onscan(npub);
                return;
              }
              status = 'qr.invalid';
            }
          }
          timer = setTimeout(scan, 200);
        } catch (cause) {
          fail(cause);
        }
      }
      scan();
    } catch (cause) {
      if (!cancelled()) fail(cause);
    } finally {
      if (!cancelled()) opening = false;
    }
  }
  onMount(() => {
    void start();
  });
  onDestroy(() => {
    disposed = true;
    stop();
  });
</script>

<section class="npub-scanner" aria-label={$translate('qr.scanNpub')} data-testid="npub-scanner">
  <video
    bind:this={video}
    autoplay
    muted
    playsinline
    aria-label={$translate('qr.preview')}
    hidden={!!error}
  ></video>
  {#if error}<p role="alert">{$translate(error)}</p>{:else}<p role="status">
      {$translate(status)}
    </p>{/if}
  <div class="scanner-actions">
    {#if error}<button class="outline" type="button" onclick={() => start()}
        >{$translate('qr.retry')}</button
      >{/if}
    {#if !error}<button class="outline" type="button" disabled={opening} onclick={switchCamera}
        >{$translate('qr.switchCamera')}</button
      >{/if}
    <button class="outline" type="button" onclick={oncancel}>{$translate('qr.cancel')}</button>
  </div>
</section>

<style>
  .npub-scanner {
    padding: 12px;
    margin: 12px 0;
    border: 1px solid var(--nc-border);
    border-radius: 12px;
  }
  video {
    display: block;
    width: 100%;
    max-height: 32dvh;
    aspect-ratio: 4 / 3;
    object-fit: contain;
    background: #000;
    border-radius: 8px;
  }
  video[hidden] {
    display: none;
  }
  p {
    margin: 12px 0;
    font-size: 14px;
  }
  .scanner-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button {
    padding: 8px 12px;
  }
</style>
