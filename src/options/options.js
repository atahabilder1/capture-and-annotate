import { getSettings, saveSettings, openShortcutSettings } from '../lib/settings.js';

const settings = await getSettings();

let toastTimer;
async function save(patch) {
  Object.assign(settings, patch);
  await saveSettings(patch);
  const toast = document.getElementById('toast');
  toast.textContent = 'Saved';
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1200);
}

for (const radio of document.querySelectorAll('input[name="afterCapture"]')) {
  radio.checked = radio.value === settings.afterCapture;
  radio.addEventListener('change', () => save({ afterCapture: radio.value }));
}

for (const group of document.querySelectorAll('.segmented[data-setting]')) {
  const key = group.dataset.setting;
  const buttons = group.querySelectorAll('button');
  const show = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.value === settings[key])));
  buttons.forEach((b) => b.addEventListener('click', () => save({ [key]: b.value }).then(show)));
  show();
}

const quality = document.getElementById('jpgQuality');
const qualityValue = document.getElementById('jpgQualityValue');
quality.value = settings.jpgQuality;
qualityValue.textContent = settings.jpgQuality;
quality.addEventListener('input', () => (qualityValue.textContent = quality.value));
quality.addEventListener('change', () => save({ jpgQuality: Number(quality.value) }));

const sticky = document.getElementById('hideStickyHeaders');
sticky.checked = settings.hideStickyHeaders;
sticky.addEventListener('change', () => save({ hideStickyHeaders: sticky.checked }));

const list = document.getElementById('shortcut-list');
for (const command of await chrome.commands.getAll()) {
  if (!command.description) continue;
  const li = document.createElement('li');
  const label = document.createElement('span');
  const kbd = document.createElement('kbd');
  label.textContent = command.description;
  kbd.textContent = command.shortcut || '';
  li.append(label, kbd);
  list.append(li);
}
document.getElementById('change-shortcuts').addEventListener('click', () => {
  if (!openShortcutSettings()) document.getElementById('shortcut-help').hidden = false;
});
