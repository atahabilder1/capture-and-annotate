import { putCapture } from '../lib/store.js';

const button = document.getElementById('choose');
const status = document.getElementById('status');

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = '';
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const dataUrl = await grabFrame(stream);
    const id = await putCapture({ mode: 'image', tiles: [{ dataUrl, y: 0 }], title: 'Screen capture', takenAt: Date.now() });
    location.replace(`../editor/editor.html?id=${id}`);
  } catch (err) {
    status.textContent =
      err.name === 'NotAllowedError' ? 'Nothing was captured. Choose a screen or window to try again.' : `Capture failed: ${err.message}`;
    button.disabled = false;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
});

async function grabFrame(stream) {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  // The first frames can be blank while the picker closes.
  await new Promise((r) => setTimeout(r, 300));
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return canvas.toDataURL('image/png');
}
