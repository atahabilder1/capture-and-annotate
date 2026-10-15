import { getSettings, saveSettings, openShortcutSettings } from '../lib/settings.js';

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

// Show whatever shortcut the user has actually assigned to each command.
const commands = await chrome.commands.getAll();
for (const button of document.querySelectorAll('[data-mode]')) {
  const command = commands.find((c) => c.name === button.dataset.command);
  const kbd = button.querySelector('kbd');
  if (kbd) kbd.textContent = command?.shortcut || '';
  button.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'capture', mode: button.dataset.mode, tabId: tab.id });
    window.close();
  });
}

document.getElementById('open-image').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/editor/editor.html'), index: tab.index + 1 });
  window.close();
});

document.getElementById('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

document.getElementById('shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  if (openShortcutSettings()) window.close();
  else chrome.runtime.openOptionsPage().then(() => window.close());
});

const delayButtons = document.querySelectorAll('[data-delay]');
function showDelay(seconds) {
  delayButtons.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.delay) === seconds)));
  document.getElementById('delay-note').hidden = seconds === 0;
}
showDelay((await getSettings()).delaySeconds);
delayButtons.forEach((b) =>
  b.addEventListener('click', () => {
    const seconds = Number(b.dataset.delay);
    saveSettings({ delaySeconds: seconds });
    showDelay(seconds);
  }),
);
