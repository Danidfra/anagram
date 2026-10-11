/** Keep the camera frame's intrinsic ratio in CSS. Layout uses each window's
 * own container dimensions, so recording-window clones resize independently. */
export function callVideoAspect(node: HTMLElement) {
  // Camera-off tiles keep their last video frame, or use a standard landscape
  // frame before any video arrives. Names use the same bottom-left anchor.
  let ratio = String(16 / 9);
  function update() {
    const video = node.querySelector('video');
    if (video?.videoWidth && video.videoHeight)
      ratio = String(video.videoWidth / video.videoHeight);
    if (node.dataset.videoRatio === ratio) return;
    node.dataset.videoRatio = ratio;
    node.style.setProperty('--video-ratio', ratio);
  }
  node.addEventListener('loadedmetadata', update, true);
  node.addEventListener('resize', update, true);
  const observer = new MutationObserver(update);
  observer.observe(node, { childList: true });
  update();
  return {
    destroy() {
      observer.disconnect();
      node.removeEventListener('loadedmetadata', update, true);
      node.removeEventListener('resize', update, true);
    },
  };
}
