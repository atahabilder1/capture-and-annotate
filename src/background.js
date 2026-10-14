import { putCapture } from './lib/store.js';

// Chrome allows ~2 captureVisibleTab calls per second; stay just under it.
const CAPTURE_INTERVAL_MS = 550;
// Safety limit for endless/infinite-scroll pages.
const MAX_TILES = 60;

let lastCaptureAt = 0;
let busy = false;

chrome.commands.onCommand.addListener(async (command, tab) => {
  const mode = { 'capture-area': 'area', 'capture-visible': 'visible', 'capture-full': 'full' }[command];
  if (mode && tab) start(mode, tab);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'capture') {
    chrome.tabs.get(msg.tabId).then((tab) => start(msg.mode, tab));
  } else if (msg.type === 'area-selected' && sender.tab) {
    finishArea(sender.tab, msg.rect, msg.viewWidth);
  }
  sendResponse({ ok: true });
});

async function start(mode, tab) {
  if (busy) return;
  try {
    if (mode === 'area') {
      // The overlay script reports back with an 'area-selected' message.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/inject/select.js'] });
    } else if (mode === 'visible') {
      busy = true;
      const dataUrl = await captureTab(tab.windowId);
      await openEditor(tab, { mode, tiles: [{ dataUrl, y: 0 }] });
    } else if (mode === 'full') {
      busy = true;
      await captureFullPage(tab);
    }
  } catch (err) {
    showError(tab, err);
  } finally {
    busy = false;
  }
}

async function finishArea(tab, rect, viewWidth) {
  try {
    busy = true;
    const dataUrl = await captureTab(tab.windowId);
    await openEditor(tab, { mode: 'area', tiles: [{ dataUrl, y: 0 }], rect, viewWidth });
  } catch (err) {
    showError(tab, err);
  } finally {
    busy = false;
  }
}

async function captureFullPage(tab) {
  const target = { tabId: tab.id };
  const exec = async (func, args = []) =>
    (await chrome.scripting.executeScript({ target, func, args }))[0].result;

  const page = await exec(preparePage);
  const tiles = [];
  try {
    let y = 0;
    for (let i = 0; i < MAX_TILES; i++) {
      const actualY = await exec(scrollPageTo, [y, i > 0]);
      // The page stopped scrolling (bottom reached or the page shrank).
      if (i > 0 && actualY <= tiles[i - 1].y) break;
      setBadge(tab.id, String(i + 1), '#2563eb');
      tiles.push({ dataUrl: await captureTab(tab.windowId), y: actualY });
      if (actualY + page.viewHeight >= page.totalHeight) break;
      y = actualY + page.viewHeight;
    }
  } finally {
    await exec(restorePage).catch(() => {});
    setBadge(tab.id, '');
  }
  await openEditor(tab, { mode: 'full', tiles, viewWidth: page.viewWidth, viewHeight: page.viewHeight });
}

async function captureTab(windowId) {
  const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCaptureAt = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

async function openEditor(tab, capture) {
  const id = await putCapture({ ...capture, title: tab.title || '', url: tab.url || '', takenAt: Date.now() });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`src/editor/editor.html?id=${id}`),
    index: tab.index + 1,
    openerTabId: tab.id,
  });
}

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

function showError(tab, err) {
  console.warn('Capture and Annotate:', err);
  const restricted = /cannot (access|be scripted)|chrome:\/\/|webstore|extensions gallery/i.test(String(err?.message));
  const message = restricted ? 'Chrome does not allow capturing this page.' : `Capture failed: ${err?.message || err}`;
  setBadge(tab.id, '!', '#dc2626');
  chrome.action.setTitle({ tabId: tab.id, title: `Capture and Annotate – ${message}` }).catch(() => {});
  setTimeout(() => {
    setBadge(tab.id, '');
    chrome.action.setTitle({ tabId: tab.id, title: 'Capture and Annotate' }).catch(() => {});
  }, 5000);
}

// ---- Functions below are injected into the page; they must be self-contained. ----

async function preparePage() {
  const style = document.createElement('style');
  style.id = '__capannotate_style';
  style.textContent =
    'html,body{scrollbar-width:none!important;scroll-behavior:auto!important}' +
    '::-webkit-scrollbar{display:none!important}';
  document.documentElement.appendChild(style);
  window.__capannotate = { x: window.scrollX, y: window.scrollY, hidden: null };
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const root = document.scrollingElement || document.documentElement;
  return {
    totalHeight: Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0),
    viewHeight: window.innerHeight,
    viewWidth: window.innerWidth,
  };
}

async function scrollPageTo(y, hideFixed) {
  const state = window.__capannotate;
  // Fixed/sticky headers would repeat on every tile; keep them only on the first.
  if (hideFixed && !state.hidden) {
    state.hidden = [];
    for (const el of document.querySelectorAll('body *')) {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') {
        state.hidden.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
        el.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }
  window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  // Give lazy-loaded images and scroll effects a moment to settle.
  await new Promise((r) => setTimeout(r, 150));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return window.scrollY;
}

function restorePage() {
  const state = window.__capannotate;
  if (!state) return;
  for (const [el, value, priority] of state.hidden || []) {
    el.style.setProperty('visibility', value, priority);
  }
  document.getElementById('__capannotate_style')?.remove();
  window.scrollTo({ top: state.y, left: state.x, behavior: 'instant' });
  delete window.__capannotate;
}
