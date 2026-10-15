// User preferences, synced across the user's browsers.

export const DEFAULTS = {
  afterCapture: 'edit', // 'edit' | 'save' | 'copy'
  saveFormat: 'png', // 'png' | 'jpg' | 'pdf'
  jpgQuality: 92, // 50–100
  pdfPageSize: 'a4', // 'a4' | 'letter' | 'fit'
  hideStickyHeaders: true,
  delaySeconds: 0, // 0 | 3 | 5 | 10
};

export async function getSettings() {
  try {
    return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  return chrome.storage.sync.set(patch);
}

// Opens the browser's page for changing extension shortcuts.
// Returns false on older Firefox, where extensions can't open that page.
export function openShortcutSettings() {
  if (chrome.commands.openShortcutSettings) {
    chrome.commands.openShortcutSettings();
  } else if (navigator.userAgent.includes('Firefox')) {
    return false;
  } else {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  }
  return true;
}
