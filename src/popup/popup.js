const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

// Show whatever shortcut the user has actually assigned to each command.
const commands = await chrome.commands.getAll();
for (const button of document.querySelectorAll('button[data-mode]')) {
  const command = commands.find((c) => c.name === button.dataset.command);
  button.querySelector('kbd').textContent = command?.shortcut || '';
  button.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'capture', mode: button.dataset.mode, tabId: tab.id });
    window.close();
  });
}

document.getElementById('shortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
