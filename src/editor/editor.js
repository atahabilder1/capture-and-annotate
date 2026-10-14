import { getCapture } from '../lib/store.js';
import { canvasToPdf } from '../lib/pdf.js';

// Chrome's canvas limits; very long pages are scaled down to fit.
const MAX_SIDE = 32767;
const MAX_AREA = 268_000_000;
const UNDO_LIMIT = 25;
const SIZES = { s: { stroke: 2, font: 16 }, m: { stroke: 4, font: 24 }, l: { stroke: 8, font: 40 } };

const $ = (sel) => document.querySelector(sel);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const stage = $('#stage');

let capture = null;
let scale = 1; // image pixels per CSS pixel of the captured page
let tool = null;
let color = '#ef4444';
let size = 'm';
let drag = null;
let textInput = null;
const undoStack = [];
const redoStack = [];

init();

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  capture = id ? await getCapture(id).catch(() => null) : null;
  if (!capture) {
    $('#message').textContent = 'This capture is no longer available. Take a new screenshot with Capture and Annotate.';
    document.querySelectorAll('.toolbar button, .toolbar input').forEach((el) => (el.disabled = true));
    return;
  }
  document.title = `Capture and Annotate – ${capture.title || 'Screenshot'}`;
  try {
    await compose(capture);
  } catch (err) {
    $('#message').textContent = `Could not open the capture: ${err.message}`;
    return;
  }
  $('#message').hidden = true;
  stage.hidden = false;
  syncSize();
  setupToolbar();
  setupDrawing();
  setupKeys();
}

// ---- Building the image from the captured screenshots ----

function loadImage(src) {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => img);
}

async function compose(c) {
  const images = await Promise.all(c.tiles.map((t) => loadImage(t.dataUrl)));
  const first = images[0];
  scale = c.viewWidth ? first.width / c.viewWidth : window.devicePixelRatio || 1;

  if (c.mode === 'area') {
    const r = c.rect;
    const sx = clamp(Math.round(r.x * scale), 0, first.width - 1);
    const sy = clamp(Math.round(r.y * scale), 0, first.height - 1);
    const sw = clamp(Math.round(r.width * scale), 1, first.width - sx);
    const sh = clamp(Math.round(r.height * scale), 1, first.height - sy);
    canvas.width = sw;
    canvas.height = sh;
    ctx.drawImage(first, sx, sy, sw, sh, 0, 0, sw, sh);
  } else if (c.mode === 'full') {
    const lastTile = c.tiles.at(-1);
    const width = first.width;
    const height = Math.round(lastTile.y * scale) + images.at(-1).height;
    const fit = Math.min(1, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
    canvas.width = Math.floor(width * fit);
    canvas.height = Math.floor(height * fit);
    c.tiles.forEach((t, i) => {
      const img = images[i];
      ctx.drawImage(img, 0, Math.round(t.y * scale * fit), img.width * fit, img.height * fit);
    });
    scale *= fit;
    if (fit < 1) toast('The page is very long, so it was scaled down to fit.');
  } else {
    canvas.width = first.width;
    canvas.height = first.height;
    ctx.drawImage(first, 0, 0);
  }
}

// Shows the image at the size it had on the page, shrunk to fit the window if needed.
function syncSize() {
  overlay.width = canvas.width;
  overlay.height = canvas.height;
  stage.style.width = `${canvas.width / scale}px`;
}

// ---- Toolbar ----

function setupToolbar() {
  document.querySelectorAll('[data-tool]').forEach((b) =>
    b.addEventListener('click', () => setTool(tool === b.dataset.tool ? null : b.dataset.tool)),
  );
  document.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => setColor(b.dataset.color)));
  $('#custom-color').addEventListener('input', (e) => setColor(e.target.value, true));
  document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => setSize(b.dataset.size)));
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#copy').addEventListener('click', copyImage);
  $('#save-png').addEventListener('click', () => save('png'));
  $('#save-jpg').addEventListener('click', () => save('jpg'));
  $('#save-pdf').addEventListener('click', () => save('pdf'));
  setColor(color);
  setSize(size);
}

function setTool(next) {
  commitText();
  tool = next;
  document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
  stage.classList.toggle('tool-active', !!tool);
  stage.classList.toggle('tool-text', tool === 'text');
}

function setColor(next, custom = false) {
  color = next;
  document.querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-pressed', String(!custom && b.dataset.color === next)));
  $('.swatch.custom').setAttribute('aria-pressed', String(custom));
  if (textInput) textInput.style.color = color;
}

function setSize(next) {
  size = next;
  document.querySelectorAll('[data-size]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === size)));
}

// ---- Drawing ----

function toImagePoint(e) {
  const r = overlay.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * overlay.width) / r.width,
    y: ((e.clientY - r.top) * overlay.height) / r.height,
  };
}

function setupDrawing() {
  overlay.addEventListener('pointerdown', (e) => {
    if (!tool || e.button !== 0) return;
    e.preventDefault();
    const p = toImagePoint(e);
    if (tool === 'text') {
      // Clicking while editing text just finishes that text.
      if (textInput) commitText();
      else startText(p);
      return;
    }
    overlay.setPointerCapture(e.pointerId);
    drag = { tool, start: p, end: p, points: [p] };
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toImagePoint(e);
    drag.end = p;
    if (drag.tool === 'pen' || drag.tool === 'highlight') drag.points.push(p);
    octx.clearRect(0, 0, overlay.width, overlay.height);
    drawPreview(drag);
  });
  const finish = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    commit(d);
  };
  overlay.addEventListener('pointerup', finish);
  overlay.addEventListener('pointercancel', () => {
    drag = null;
    octx.clearRect(0, 0, overlay.width, overlay.height);
  });
}

function strokeWidth() {
  return SIZES[size].stroke * scale;
}

function boxOf(d) {
  const x = Math.round(Math.min(d.start.x, d.end.x));
  const y = Math.round(Math.min(d.start.y, d.end.y));
  return {
    x,
    y,
    w: Math.round(Math.max(d.start.x, d.end.x)) - x,
    h: Math.round(Math.max(d.start.y, d.end.y)) - y,
  };
}

function drawPreview(d) {
  const b = boxOf(d);
  if (d.tool === 'crop') {
    octx.fillStyle = 'rgba(15, 23, 42, 0.5)';
    octx.fillRect(0, 0, overlay.width, overlay.height);
    octx.clearRect(b.x, b.y, b.w, b.h);
    dashedRect(b);
  } else if (d.tool === 'blur') {
    octx.fillStyle = 'rgba(100, 116, 139, 0.35)';
    octx.fillRect(b.x, b.y, b.w, b.h);
    dashedRect(b);
  } else {
    drawShape(octx, d);
  }
}

function dashedRect(b) {
  octx.save();
  octx.lineWidth = Math.max(1, scale);
  octx.setLineDash([6 * scale, 4 * scale]);
  octx.strokeStyle = '#fff';
  octx.strokeRect(b.x, b.y, b.w, b.h);
  octx.lineDashOffset = 6 * scale;
  octx.strokeStyle = '#2563eb';
  octx.strokeRect(b.x, b.y, b.w, b.h);
  octx.restore();
}

function drawShape(c, d) {
  c.save();
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = strokeWidth();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (d.tool === 'pen' || d.tool === 'highlight') {
    if (d.tool === 'highlight') {
      c.globalAlpha = 0.35;
      c.lineWidth = strokeWidth() * 5;
      c.lineCap = 'square';
    }
    c.beginPath();
    c.moveTo(d.points[0].x, d.points[0].y);
    for (const p of d.points.slice(1)) c.lineTo(p.x, p.y);
    if (d.points.length === 1) c.lineTo(d.points[0].x + 0.1, d.points[0].y);
    c.stroke();
  } else if (d.tool === 'rect') {
    const b = boxOf(d);
    c.strokeRect(b.x, b.y, b.w, b.h);
  } else if (d.tool === 'arrow') {
    const { start: a, end: z } = d;
    const angle = Math.atan2(z.y - a.y, z.x - a.x);
    const head = Math.max(14 * scale, strokeWidth() * 4);
    // Stop the line short so its round cap doesn't poke through the arrowhead.
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(z.x - Math.cos(angle) * head * 0.6, z.y - Math.sin(angle) * head * 0.6);
    c.stroke();
    c.beginPath();
    c.moveTo(z.x, z.y);
    c.lineTo(z.x - head * Math.cos(angle - Math.PI / 7), z.y - head * Math.sin(angle - Math.PI / 7));
    c.lineTo(z.x - head * Math.cos(angle + Math.PI / 7), z.y - head * Math.sin(angle + Math.PI / 7));
    c.closePath();
    c.fill();
  }
  c.restore();
}

function commit(d) {
  const b = boxOf(d);
  const isBox = d.tool === 'crop' || d.tool === 'blur' || d.tool === 'rect' || d.tool === 'arrow';
  if (isBox && Math.hypot(b.w, b.h) < 4) return; // ignore stray clicks

  pushUndo();
  if (d.tool === 'crop') {
    const r = clipBox(b);
    if (r.w < 2 || r.h < 2) return void undoStack.pop();
    const copy = snapshot();
    canvas.width = r.w;
    canvas.height = r.h;
    ctx.drawImage(copy, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    syncSize();
    setTool(null);
  } else if (d.tool === 'blur') {
    pixelate(clipBox(b));
  } else {
    drawShape(ctx, d);
  }
}

function clipBox(b) {
  const x = clamp(b.x, 0, canvas.width);
  const y = clamp(b.y, 0, canvas.height);
  return { x, y, w: clamp(b.x + b.w, 0, canvas.width) - x, h: clamp(b.y + b.h, 0, canvas.height) - y };
}

function pixelate(r) {
  if (r.w < 1 || r.h < 1) return;
  const block = Math.max(6, Math.round(10 * scale));
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.ceil(r.w / block));
  small.height = Math.max(1, Math.ceil(r.h / block));
  small.getContext('2d').drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, small.width, small.height, r.x, r.y, r.w, r.h);
  ctx.restore();
}

// ---- Text ----

function startText(p) {
  const ratio = stage.clientWidth / canvas.width; // CSS px per image px
  const fontPx = SIZES[size].font * scale;
  const input = document.createElement('input');
  input.className = 'text-input';
  input.style.left = `${p.x * ratio}px`;
  input.style.top = `${p.y * ratio}px`;
  input.style.fontSize = `${fontPx * ratio}px`;
  input.style.color = color;
  input.dataset.x = p.x;
  input.dataset.y = p.y;
  input.dataset.font = fontPx;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commitText();
    if (e.key === 'Escape') cancelText();
  });
  input.addEventListener('blur', () => commitText());
  stage.appendChild(input);
  textInput = input;
  // Focus after this pointer event, or the click would blur it right away.
  setTimeout(() => input.focus());
}

function commitText() {
  const input = textInput;
  if (!input) return;
  textInput = null;
  const text = input.value.trim();
  input.remove();
  if (!text) return;
  pushUndo();
  ctx.save();
  ctx.font = `600 ${input.dataset.font}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = input.style.color;
  ctx.fillText(text, Number(input.dataset.x), Number(input.dataset.y));
  ctx.restore();
}

function cancelText() {
  textInput?.remove();
  textInput = null;
}

// ---- Undo / redo ----

function snapshot() {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, 0, 0);
  return c;
}

function restore(snap) {
  canvas.width = snap.width;
  canvas.height = snap.height;
  ctx.drawImage(snap, 0, 0);
  syncSize();
}

function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateHistoryButtons();
}

function undo() {
  commitText();
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  updateHistoryButtons();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
}

// ---- Saving ----

function toBlob(type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image too large to export'))), type, quality),
  );
}

async function save(kind) {
  commitText();
  const button = $(`#save-${kind}`);
  button.disabled = true;
  try {
    let blob;
    if (kind === 'png') blob = await toBlob('image/png');
    else if (kind === 'jpg') blob = await toBlob('image/jpeg', 0.92);
    else {
      toast('Making PDF…');
      blob = await canvasToPdf(canvas);
    }
    download(blob, kind);
    toast(`Saved as ${kind.toUpperCase()}`);
  } catch (err) {
    toast(`Could not save: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

function download(blob, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName(ext);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

function fileName(ext) {
  const d = new Date(capture.takenAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  const title = (capture.title || 'Screenshot').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${title || 'Screenshot'} ${stamp}.${ext}`;
}

async function copyImage() {
  commitText();
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob('image/png') })]);
    toast('Copied to clipboard');
  } catch (err) {
    toast(`Could not copy: ${err.message}`);
  }
}

// ---- Keyboard ----

function setupKeys() {
  const toolKeys = { c: 'crop', p: 'pen', h: 'highlight', r: 'rect', a: 'arrow', t: 'text', b: 'blur' };
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'color') return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && key === 's') {
      e.preventDefault();
      save('png');
    } else if (mod && key === 'c' && !window.getSelection()?.toString()) {
      e.preventDefault();
      copyImage();
    } else if (e.key === 'Escape') {
      setTool(null);
    } else if (!mod && !e.altKey && toolKeys[key]) {
      setTool(tool === toolKeys[key] ? null : toolKeys[key]);
    }
  });
}

// ---- Helpers ----

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}
