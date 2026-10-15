import { getCapture } from '../lib/store.js';
import { canvasToPdf } from '../lib/pdf.js';
import { getSettings } from '../lib/settings.js';

// Chrome/Firefox canvas limits; very long pages are scaled down to fit.
const MAX_SIDE = 32767;
const MAX_AREA = 200_000_000;
const HISTORY_LIMIT = 100;
// Sizes in CSS pixels of the captured page; multiplied by `scale` for image pixels.
const SIZES = {
  s: { stroke: 2, font: 16, step: 12 },
  m: { stroke: 4, font: 22, step: 16 },
  l: { stroke: 8, font: 32, step: 22 },
};
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
const BOX_TYPES = new Set(['rect', 'ellipse', 'blur']);
const FILL_TYPES = new Set(['rect', 'ellipse', 'text']);
const TOOL_KEYS = {
  v: 'select', p: 'pen', h: 'highlight', l: 'line', a: 'arrow', r: 'rect',
  e: 'ellipse', n: 'step', t: 'text', b: 'blur', c: 'crop',
};
const FONT_FAMILY = '"Instrument Sans", system-ui, sans-serif';

const $ = (sel) => document.querySelector(sel);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const stage = $('#stage');
const workspace = $('#workspace');
const stylebar = $('#stylebar');
const measureCtx = document.createElement('canvas').getContext('2d');

let settings;
let meta = { title: 'Screenshot', takenAt: Date.now() };
let base = null; // the captured image, never modified
let scale = 1; // image pixels per CSS pixel of the captured page
let doc = { crop: null, shapes: [] }; // shapes use base-image coordinates
let nextId = 1;
let tool = 'select';
const style = { color: '#e5383b', size: 'm', fill: false };
let selectedId = null;
let editing = null; // text being typed: { shape, el, isNew, before }
let action = null; // pointer gesture in progress
let zoom = 'fit';
let unsaved = false;
const undoStack = [];
const redoStack = [];
const blurCache = new WeakMap();

init();

async function init() {
  settings = await getSettings();
  setupToolbar();
  setupPointer();
  setupKeys();
  setupEmptyState();
  document.fonts.load(`600 20px ${FONT_FAMILY}`).catch(() => {});

  const id = new URLSearchParams(location.search).get('id');
  if (!id) return setState('empty');

  const capture = await getCapture(id).catch(() => null);
  if (!capture) return showMessage('This capture is no longer available. Take a new one with the toolbar button.');
  try {
    base = await compose(capture);
  } catch (err) {
    return showMessage(`The capture could not be opened: ${err.message}`);
  }
  meta = { title: capture.title || 'Screenshot', takenAt: capture.takenAt || Date.now() };
  await document.fonts.ready;
  begin();

  if (settings.afterCapture === 'save') await save(settings.saveFormat, 'You can keep editing and save again.');
  else if (settings.afterCapture === 'copy') await copyImage();
}

function setState(state) {
  document.body.dataset.state = state;
}

function showMessage(text) {
  $('#message').textContent = text;
  setState('message');
}

function begin() {
  $('#doc-title').textContent = meta.title;
  document.title = `${meta.title} – Capture and Annotate`;
  setState('ready');
  resizeView();
  setTool('select');
  updateHistoryButtons();
}

// ---- Building the image ----

function loadImage(src) {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => img);
}

async function compose(c) {
  const images = await Promise.all(c.tiles.map((t) => loadImage(t.dataUrl)));
  const first = images[0];
  const out = document.createElement('canvas');
  const octx2 = out.getContext('2d');

  if (c.mode === 'image') {
    scale = imageScale(first.width);
  } else {
    scale = c.viewWidth ? first.width / c.viewWidth : window.devicePixelRatio || 1;
  }

  if (c.mode === 'area') {
    const r = c.rect;
    const sx = clamp(Math.round(r.x * scale), 0, first.width - 1);
    const sy = clamp(Math.round(r.y * scale), 0, first.height - 1);
    out.width = clamp(Math.round(r.width * scale), 1, first.width - sx);
    out.height = clamp(Math.round(r.height * scale), 1, first.height - sy);
    octx2.drawImage(first, sx, sy, out.width, out.height, 0, 0, out.width, out.height);
  } else if (c.mode === 'full') {
    const width = first.width;
    const height = Math.round(c.tiles.at(-1).y * scale) + images.at(-1).height;
    const fit = Math.min(1, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
    out.width = Math.floor(width * fit);
    out.height = Math.floor(height * fit);
    c.tiles.forEach((t, i) => {
      const img = images[i];
      octx2.drawImage(img, 0, Math.round(t.y * scale * fit), img.width * fit, img.height * fit);
    });
    scale *= fit;
    if (fit < 1) setTimeout(() => toast('This page is very long, so it was scaled down to fit.'), 400);
  } else {
    out.width = first.width;
    out.height = first.height;
    octx2.drawImage(first, 0, 0);
  }
  return out;
}

// Large photos get proportionally thicker strokes so annotations stay visible.
function imageScale(width) {
  return Math.max(window.devicePixelRatio || 1, width / 1600);
}

async function openImageFile(file) {
  if (!file || !file.type.startsWith('image/')) return toast('That file is not an image.');
  try {
    const img = await loadImage(URL.createObjectURL(file));
    base = document.createElement('canvas');
    base.width = img.width;
    base.height = img.height;
    base.getContext('2d').drawImage(img, 0, 0);
    URL.revokeObjectURL(img.src);
  } catch {
    return toast('This image could not be opened.');
  }
  scale = imageScale(base.width);
  meta = { title: file.name ? file.name.replace(/\.[^.]+$/, '') : 'Pasted image', takenAt: Date.now() };
  await document.fonts.ready;
  begin();
}

// ---- View, zoom and rendering ----

function view() {
  return doc.crop || { x: 0, y: 0, w: base.width, h: base.height };
}

function resizeView() {
  const v = view();
  canvas.width = v.w;
  canvas.height = v.h;
  $('#doc-meta').textContent = `${v.w} × ${v.h} px`;
  stylebar.classList.toggle('has-crop', !!doc.crop);
  applyZoom();
  render();
}

function naturalWidth() {
  return canvas.width / scale;
}

function currentZoom() {
  if (zoom !== 'fit') return zoom;
  const available = workspace.clientWidth - 64;
  return Math.min(1, available / naturalWidth());
}

function applyZoom(next = zoom) {
  zoom = next;
  const z = currentZoom();
  const w = naturalWidth() * z;
  const h = (w * canvas.height) / canvas.width;
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  $('#zoom-fit').textContent = `${Math.round(z * 100)}%`;
  // The overlay only shows previews and handles, so screen resolution is enough.
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.max(1, Math.min(canvas.width, Math.round(w * dpr)));
  overlay.height = Math.max(1, Math.round((overlay.width * canvas.height) / canvas.width));
  drawOverlay();
  if (editing) layoutTextEditor();
}

function zoomStep(direction) {
  const z = currentZoom();
  const next =
    direction > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) ?? ZOOM_STEPS.at(-1) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? ZOOM_STEPS[0];
  applyZoom(next);
}

// Redraws the image and annotations; `dirty` (base coordinates) limits the work to one area.
function render(dirty) {
  if (!base) return;
  const v = view();
  let area = v;
  if (dirty) {
    area = intersect(roundOut(dirty), v);
    if (!area) return;
  }
  ctx.save();
  ctx.translate(-v.x, -v.y);
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  ctx.clearRect(area.x, area.y, area.w, area.h);
  ctx.drawImage(base, area.x, area.y, area.w, area.h, area.x, area.y, area.w, area.h);
  let step = 0;
  for (const s of doc.shapes) {
    if (s.type === 'step') step++;
    if (editing?.shape === s) continue;
    if (dirty && !intersect(bounds(s), area)) continue;
    drawShape(ctx, s, step);
  }
  ctx.restore();
}

// Draws previews and the selection on the overlay canvas.
function drawOverlay() {
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!base) return;
  const v = view();
  const k = overlay.width / canvas.width;
  octx.setTransform(k, 0, 0, k, -v.x * k, -v.y * k);

  if (action?.kind === 'draw') {
    const d = action.shape;
    if (d.type === 'crop') {
      const b = normBox(d);
      octx.fillStyle = 'rgba(18, 22, 29, 0.5)';
      octx.beginPath();
      octx.rect(v.x, v.y, v.w, v.h);
      octx.rect(b.x, b.y + b.h, b.w, -b.h); // opposite winding cuts a hole
      octx.fill('evenodd');
      drawFrame(b, true);
    } else if (d.type === 'blur') {
      const b = normBox(d);
      octx.fillStyle = 'rgba(123, 133, 151, 0.35)';
      octx.fillRect(b.x, b.y, b.w, b.h);
      drawFrame(b, false);
    } else {
      drawShape(octx, BOX_TYPES.has(d.type) ? { ...d, ...normBox(d) } : d, countSteps() + 1);
    }
  }

  const sel = selected();
  if (sel && !editing) {
    drawFrame(shapeBox(sel), true);
    for (const h of handles(sel)) drawHandle(h);
  }
}

function drawFrame(b, corners) {
  const px = screenPx(1);
  octx.save();
  octx.lineWidth = px;
  octx.strokeStyle = 'rgba(47, 76, 221, 0.7)';
  octx.strokeRect(b.x, b.y, b.w, b.h);
  if (corners) {
    // Crop-mark corners, matching the rest of the interface.
    const len = Math.min(screenPx(12), b.w / 2, b.h / 2);
    const o = screenPx(4);
    octx.lineWidth = screenPx(2.5);
    octx.strokeStyle = '#2f4cdd';
    octx.lineCap = 'square';
    const x1 = b.x - o, y1 = b.y - o, x2 = b.x + b.w + o, y2 = b.y + b.h + o;
    octx.beginPath();
    octx.moveTo(x1, y1 + len); octx.lineTo(x1, y1); octx.lineTo(x1 + len, y1);
    octx.moveTo(x2 - len, y1); octx.lineTo(x2, y1); octx.lineTo(x2, y1 + len);
    octx.moveTo(x1, y2 - len); octx.lineTo(x1, y2); octx.lineTo(x1 + len, y2);
    octx.moveTo(x2 - len, y2); octx.lineTo(x2, y2); octx.lineTo(x2, y2 - len);
    octx.stroke();
  }
  octx.restore();
}

function drawHandle(h) {
  octx.save();
  octx.beginPath();
  octx.arc(h.x, h.y, screenPx(5.5), 0, Math.PI * 2);
  octx.fillStyle = '#fff';
  octx.fill();
  octx.lineWidth = screenPx(2);
  octx.strokeStyle = '#2f4cdd';
  octx.stroke();
  octx.restore();
}

// Converts on-screen CSS pixels to image pixels at the current zoom.
function screenPx(n) {
  return (n * canvas.width) / Math.max(1, stage.clientWidth);
}

function toBase(e) {
  const r = overlay.getBoundingClientRect();
  const v = view();
  return {
    x: v.x + ((e.clientX - r.left) * canvas.width) / r.width,
    y: v.y + ((e.clientY - r.top) * canvas.height) / r.height,
  };
}

// ---- Shapes ----

function lineWidth(s) {
  const w = SIZES[s.size].stroke * scale;
  return s.type === 'highlight' ? w * 5 : w;
}

function fontPx(s) {
  return SIZES[s.size].font * scale;
}

function stepRadius(s) {
  return SIZES[s.size].step * scale;
}

function contrastColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#1b2433' : '#ffffff';
}

function textLayout(s) {
  const size = fontPx(s);
  measureCtx.font = `600 ${size}px ${FONT_FAMILY}`;
  const lines = s.text.split('\n');
  const lineHeight = size * 1.25;
  const pad = s.fill ? size * 0.35 : 0;
  const width = Math.max(size * 0.5, ...lines.map((l) => measureCtx.measureText(l).width));
  return { size, lines, lineHeight, pad, box: { x: s.x, y: s.y, w: width + pad * 2, h: lines.length * lineHeight + pad * 2 } };
}

function drawShape(c, s, stepNumber) {
  c.save();
  c.strokeStyle = s.color;
  c.fillStyle = s.color;
  c.lineWidth = s.type === 'blur' ? 1 : lineWidth(s);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  switch (s.type) {
    case 'pen':
    case 'highlight': {
      if (s.type === 'highlight') {
        c.globalAlpha = 0.4;
        c.lineCap = 'square';
        if (c === ctx) c.globalCompositeOperation = 'multiply';
      }
      c.beginPath();
      c.moveTo(s.points[0].x, s.points[0].y);
      for (const p of s.points.slice(1)) c.lineTo(p.x, p.y);
      if (s.points.length === 1) c.lineTo(s.points[0].x + 0.1, s.points[0].y);
      c.stroke();
      break;
    }
    case 'line':
      c.beginPath();
      c.moveTo(s.x1, s.y1);
      c.lineTo(s.x2, s.y2);
      c.stroke();
      break;
    case 'arrow': {
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const head = Math.max(12 * scale, lineWidth(s) * 3.6);
      // Stop the shaft short so its round cap doesn't poke through the arrowhead.
      c.beginPath();
      c.moveTo(s.x1, s.y1);
      c.lineTo(s.x2 - Math.cos(angle) * head * 0.7, s.y2 - Math.sin(angle) * head * 0.7);
      c.stroke();
      c.beginPath();
      c.moveTo(s.x2, s.y2);
      c.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 7), s.y2 - head * Math.sin(angle - Math.PI / 7));
      c.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 7), s.y2 - head * Math.sin(angle + Math.PI / 7));
      c.closePath();
      c.lineWidth = Math.max(1, lineWidth(s) * 0.5);
      c.fill();
      c.stroke();
      break;
    }
    case 'rect':
    case 'ellipse': {
      c.beginPath();
      if (s.type === 'rect') c.roundRect(s.x, s.y, s.w, s.h, Math.min(lineWidth(s), s.w / 2, s.h / 2));
      else c.ellipse(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, s.h / 2, 0, 0, Math.PI * 2);
      if (s.fill) {
        c.globalAlpha = 0.22;
        c.fill();
        c.globalAlpha = 1;
      }
      c.stroke();
      break;
    }
    case 'blur':
      drawBlur(c, s);
      break;
    case 'step': {
      const r = stepRadius(s);
      c.beginPath();
      c.arc(s.x, s.y, r, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = Math.max(1.5, r * 0.16);
      c.strokeStyle = contrastColor(s.color) === '#ffffff' ? '#ffffff' : '#1b2433';
      c.stroke();
      c.fillStyle = contrastColor(s.color);
      c.font = `700 ${r * 1.15}px ${FONT_FAMILY}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(String(stepNumber), s.x, s.y + r * 0.06);
      break;
    }
    case 'text': {
      const t = textLayout(s);
      c.font = `600 ${t.size}px ${FONT_FAMILY}`;
      c.textBaseline = 'top';
      if (s.fill) {
        c.beginPath();
        c.roundRect(t.box.x, t.box.y, t.box.w, t.box.h, t.size * 0.22);
        c.fill();
        c.fillStyle = contrastColor(s.color);
      } else {
        // A soft halo keeps text readable on busy screenshots.
        c.lineWidth = t.size * 0.18;
        c.strokeStyle = contrastColor(s.color) === '#ffffff' ? 'rgba(255,255,255,0.9)' : 'rgba(27,36,51,0.85)';
      }
      t.lines.forEach((line, i) => {
        const y = s.y + t.pad + i * t.lineHeight + t.size * 0.1;
        if (!s.fill) c.strokeText(line, s.x + t.pad, y);
        c.fillText(line, s.x + t.pad, y);
      });
      break;
    }
  }
  c.restore();
}

function drawBlur(c, s) {
  const b = roundOut(normBox(s));
  const r = intersect(b, { x: 0, y: 0, w: base.width, h: base.height });
  if (!r) return;
  const key = `${r.x},${r.y},${r.w},${r.h}`;
  let cached = blurCache.get(s);
  if (cached?.key !== key) {
    const block = Math.max(6, Math.round(10 * scale));
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.ceil(r.w / block));
    small.height = Math.max(1, Math.ceil(r.h / block));
    small.getContext('2d').drawImage(base, r.x, r.y, r.w, r.h, 0, 0, small.width, small.height);
    cached = { key, small };
    blurCache.set(s, cached);
  }
  c.imageSmoothingEnabled = false;
  c.drawImage(cached.small, 0, 0, cached.small.width, cached.small.height, r.x, r.y, r.w, r.h);
}

// Box around the visible shape, used for selection and redraw areas.
function shapeBox(s) {
  switch (s.type) {
    case 'pen':
    case 'highlight': {
      const xs = s.points.map((p) => p.x);
      const ys = s.points.map((p) => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case 'line':
    case 'arrow':
      return normBox({ x: s.x1, y: s.y1, w: s.x2 - s.x1, h: s.y2 - s.y1 });
    case 'step': {
      const r = stepRadius(s);
      return { x: s.x - r, y: s.y - r, w: r * 2, h: r * 2 };
    }
    case 'text':
      return textLayout(s).box;
    default:
      return normBox(s);
  }
}

function bounds(s) {
  const b = shapeBox(s);
  let pad = s.type === 'blur' ? 2 : lineWidth(s);
  if (s.type === 'arrow') pad = Math.max(pad, 14 * scale, lineWidth(s) * 4);
  if (s.type === 'text') pad = fontPx(s) * 0.2;
  if (s.type === 'step') pad = stepRadius(s) * 0.2;
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

function hitTest(s, p, tol) {
  const w = (s.type === 'blur' ? 0 : lineWidth(s) / 2) + tol;
  switch (s.type) {
    case 'pen':
    case 'highlight':
      return s.points.some((q, i) => (i === 0 ? dist(p, q) : distToSegment(p, s.points[i - 1], q)) <= w);
    case 'line':
    case 'arrow':
      return distToSegment(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) <= w;
    case 'rect':
      return s.fill ? inBox(p, s, tol) : inBox(p, s, w) && !inBox(p, s, -w);
    case 'ellipse': {
      const rx = Math.abs(s.w) / 2, ry = Math.abs(s.h) / 2;
      if (rx < 2 || ry < 2) return inBox(p, s, w);
      const b = normBox(s);
      const d = Math.hypot((p.x - b.x - rx) / rx, (p.y - b.y - ry) / ry);
      return s.fill ? d <= 1 + w / Math.min(rx, ry) : Math.abs(d - 1) * Math.min(rx, ry) <= w;
    }
    case 'step':
      return dist(p, s) <= stepRadius(s) + tol;
    case 'text':
      return inBox(p, textLayout(s).box, tol);
    default:
      return inBox(p, s, tol);
  }
}

function handles(s) {
  if (BOX_TYPES.has(s.type)) {
    const b = normBox(s);
    return [
      { name: 'nw', x: b.x, y: b.y },
      { name: 'ne', x: b.x + b.w, y: b.y },
      { name: 'sw', x: b.x, y: b.y + b.h },
      { name: 'se', x: b.x + b.w, y: b.y + b.h },
    ];
  }
  if (s.type === 'line' || s.type === 'arrow') {
    return [
      { name: 'p1', x: s.x1, y: s.y1 },
      { name: 'p2', x: s.x2, y: s.y2 },
    ];
  }
  return [];
}

function moveShape(s, dx, dy) {
  if (s.points) s.points = s.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  else if ('x1' in s) Object.assign(s, { x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy });
  else Object.assign(s, { x: s.x + dx, y: s.y + dy });
}

function resizeShape(s, handle, p) {
  if (handle === 'p1') return Object.assign(s, { x1: p.x, y1: p.y });
  if (handle === 'p2') return Object.assign(s, { x2: p.x, y2: p.y });
  const b = normBox(s);
  const ax = handle.includes('w') ? b.x + b.w : b.x;
  const ay = handle.includes('n') ? b.y + b.h : b.y;
  Object.assign(s, normBox({ x: ax, y: ay, w: p.x - ax, h: p.y - ay }));
}

function selected() {
  return doc.shapes.find((s) => s.id === selectedId) || null;
}

function countSteps() {
  return doc.shapes.filter((s) => s.type === 'step').length;
}

function topShapeAt(p) {
  const tol = screenPx(5);
  for (let i = doc.shapes.length - 1; i >= 0; i--) {
    if (hitTest(doc.shapes[i], p, tol)) return doc.shapes[i];
  }
  return null;
}

function select(id) {
  selectedId = id;
  const s = selected();
  if (s) {
    style.color = s.color ?? style.color;
    style.size = s.size ?? style.size;
    if (FILL_TYPES.has(s.type)) style.fill = !!s.fill;
  }
  syncStylebar();
  drawOverlay();
}

// ---- Pointer input ----

function setupPointer() {
  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointercancel', () => {
    action = null;
    drawOverlay();
  });
  overlay.addEventListener('dblclick', (e) => {
    const s = topShapeAt(toBase(e));
    if (s?.type === 'text') {
      select(s.id);
      startTextEdit(s);
    }
  });
}

function onPointerDown(e) {
  if (!base || e.button !== 0) return;
  e.preventDefault();
  if (editing) {
    commitText();
    if (tool === 'text') return;
  }
  const p = toBase(e);
  overlay.setPointerCapture(e.pointerId);

  const sel = selected();
  if (sel && tool !== 'crop') {
    const h = handles(sel).find((h) => dist(h, p) <= screenPx(9));
    if (h) {
      action = { kind: 'resize', shape: sel, handle: h.name, before: snapshot(), changed: false };
      return;
    }
  }

  if (tool === 'select') {
    const s = topShapeAt(p);
    select(s?.id ?? null);
    if (s) action = { kind: 'move', shape: s, last: p, before: snapshot(), changed: false };
    return;
  }

  if (tool === 'text') {
    const s = topShapeAt(p);
    if (s?.type === 'text') {
      select(s.id);
      startTextEdit(s);
    } else {
      select(null);
      startTextEdit({ id: nextId++, type: 'text', x: p.x, y: p.y - fontPx(style) * 0.6, text: '', color: style.color, size: style.size, fill: style.fill });
    }
    return;
  }

  if (tool === 'step') {
    commitChange(() => doc.shapes.push({ id: nextId++, type: 'step', x: p.x, y: p.y, color: style.color, size: style.size }));
    const s = doc.shapes.at(-1);
    render(bounds(s));
    select(s.id);
    return;
  }

  select(null);
  const common = { id: nextId++, type: tool, color: style.color, size: style.size };
  let shape;
  if (tool === 'pen' || tool === 'highlight') shape = { ...common, points: [p] };
  else if (tool === 'line' || tool === 'arrow') shape = { ...common, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  else shape = { ...common, fill: style.fill, x: p.x, y: p.y, w: 0, h: 0 };
  action = { kind: 'draw', shape, start: p };
}

function onPointerMove(e) {
  if (!base) return;
  const p = toBase(e);
  if (!action) return updateHoverCursor(p);

  if (action.kind === 'draw') {
    const s = action.shape;
    if (s.points) {
      const last = s.points.at(-1);
      if (dist(last, p) >= screenPx(1.5)) s.points.push(p);
    } else if ('x1' in s) {
      Object.assign(s, { x2: p.x, y2: p.y });
      if (e.shiftKey) snapAngle(s);
    } else {
      Object.assign(s, { w: p.x - action.start.x, h: p.y - action.start.y });
      if (e.shiftKey) {
        const m = Math.max(Math.abs(s.w), Math.abs(s.h));
        s.w = Math.sign(s.w || 1) * m;
        s.h = Math.sign(s.h || 1) * m;
      }
    }
    drawOverlay();
    return;
  }

  const s = action.shape;
  const before = bounds(s);
  if (action.kind === 'move') {
    moveShape(s, p.x - action.last.x, p.y - action.last.y);
    action.last = p;
  } else {
    resizeShape(s, action.handle, p);
  }
  if (!action.changed) {
    action.changed = true;
    pushUndo(action.before);
  }
  render(union(before, bounds(s)));
  drawOverlay();
}

function onPointerUp() {
  if (!action) return;
  const a = action;
  action = null;
  if (a.kind === 'draw') finishDrawing(a.shape);
  else if (a.changed && BOX_TYPES.has(a.shape.type)) Object.assign(a.shape, normBox(a.shape));
  drawOverlay();
}

function finishDrawing(s) {
  const minSize = screenPx(4);
  if (s.type === 'crop') {
    const b = intersect(roundOut(normBox(s)), view());
    if (b && b.w >= minSize && b.h >= minSize) {
      commitChange(() => (doc.crop = b));
      resizeView();
      setTool('select');
    }
    return;
  }
  if ('x1' in s && dist({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) < minSize) return;
  if ('w' in s) {
    Object.assign(s, normBox(s));
    if (s.w < minSize || s.h < minSize) return;
  }
  commitChange(() => doc.shapes.push(s));
  render(bounds(s));
  select(s.id);
}

function snapAngle(s) {
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  const len = dist({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
  s.x2 = s.x1 + Math.cos(snapped) * len;
  s.y2 = s.y1 + Math.sin(snapped) * len;
}

function updateHoverCursor(p) {
  let cursor = '';
  const sel = selected();
  const h = sel && tool !== 'crop' ? handles(sel).find((h) => dist(h, p) <= screenPx(9)) : null;
  if (h) cursor = h.name === 'nw' || h.name === 'se' ? 'nwse-resize' : h.name === 'ne' || h.name === 'sw' ? 'nesw-resize' : 'move';
  else if (tool === 'select' && topShapeAt(p)) cursor = 'move';
  overlay.style.cursor = cursor;
}

// ---- Text ----

function startTextEdit(shape) {
  const isNew = !doc.shapes.includes(shape);
  const el = document.createElement('textarea');
  el.className = 'text-editor';
  el.value = shape.text;
  el.spellcheck = false;
  el.setAttribute('aria-label', 'Text');
  editing = { shape, el, isNew, before: snapshot() };
  stage.append(el);
  layoutTextEditor();
  if (!isNew) render(bounds(shape));
  drawOverlay();
  el.addEventListener('input', () => {
    shape.text = el.value;
    layoutTextEditor();
  });
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commitText();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelText();
    }
  });
  el.addEventListener('blur', () => commitText());
  // Focus after the current pointer event, or the click would blur it right away.
  setTimeout(() => {
    el.focus();
    el.select();
  });
}

function layoutTextEditor() {
  const { shape, el } = editing;
  const v = view();
  const ratio = stage.clientWidth / canvas.width;
  const t = textLayout({ ...shape, text: el.value || ' ' });
  Object.assign(el.style, {
    left: `${(shape.x - v.x) * ratio}px`,
    top: `${(shape.y - v.y) * ratio}px`,
    width: `${(t.box.w + t.size * 0.6) * ratio}px`,
    height: `${t.box.h * ratio}px`,
    fontSize: `${t.size * ratio}px`,
    padding: `${(t.pad + t.size * 0.1) * ratio}px ${t.pad * ratio}px 0`,
    color: shape.fill ? contrastColor(shape.color) : shape.color,
    background: shape.fill ? shape.color : 'transparent',
    borderRadius: `${t.size * 0.22 * ratio}px`,
  });
}

function commitText() {
  if (!editing) return;
  const { shape, el, isNew, before } = editing;
  editing = null;
  el.remove();
  const text = el.value.replace(/\s+$/, '');
  shape.text = text;
  const index = doc.shapes.indexOf(shape);
  if (!text.trim()) {
    if (!isNew) {
      pushUndo(before);
      doc.shapes.splice(index, 1);
      selectedId = null;
    }
  } else if (isNew) {
    pushUndo(before);
    doc.shapes.push(shape);
    selectedId = shape.id;
  } else if (JSON.stringify(JSON.parse(before).shapes[index]) !== JSON.stringify(shape)) {
    pushUndo(before);
  }
  render();
  select(selectedId);
}

function cancelText() {
  if (!editing) return;
  const { shape, el, isNew, before } = editing;
  editing = null;
  el.remove();
  if (!isNew) Object.assign(shape, JSON.parse(before).shapes.find((s) => s.id === shape.id));
  render();
  drawOverlay();
}

// ---- History ----

function snapshot() {
  return JSON.stringify(doc);
}

function pushUndo(state) {
  undoStack.push(state);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  unsaved = true;
  updateHistoryButtons();
}

function commitChange(change) {
  pushUndo(snapshot());
  change();
}

function restore(state) {
  const cropBefore = JSON.stringify(doc.crop);
  doc = JSON.parse(state);
  if (!selected()) selectedId = null;
  if (JSON.stringify(doc.crop) !== cropBefore) resizeView();
  else render();
  select(selectedId);
  updateHistoryButtons();
}

function undo() {
  if (editing) return cancelText();
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  unsaved = true;
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  unsaved = true;
}

function updateHistoryButtons() {
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
}

function deleteSelected() {
  const s = selected();
  if (!s) return;
  commitChange(() => doc.shapes.splice(doc.shapes.indexOf(s), 1));
  // Removing a step renumbers the ones after it, so redraw everything.
  render(s.type === 'step' ? undefined : bounds(s));
  select(null);
}

// ---- Toolbar ----

function setupToolbar() {
  document.querySelectorAll('[data-tool]').forEach((b) => {
    b.classList.add('crop-marks');
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });
  document.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => setStyle({ color: b.dataset.color })));
  $('#custom-color').addEventListener('input', (e) => setStyle({ color: e.target.value }, true));
  $('#custom-color').addEventListener('change', (e) => setStyle({ color: e.target.value }));
  document.querySelectorAll('[data-size]').forEach((b) => b.addEventListener('click', () => setStyle({ size: b.dataset.size })));
  $('#fill').addEventListener('click', () => setStyle({ fill: !style.fill }));
  $('#delete').addEventListener('click', deleteSelected);
  $('#reset-crop').addEventListener('click', () => {
    commitChange(() => (doc.crop = null));
    resizeView();
  });
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#zoom-in').addEventListener('click', () => zoomStep(1));
  $('#zoom-out').addEventListener('click', () => zoomStep(-1));
  $('#zoom-fit').addEventListener('click', () => applyZoom(zoom === 'fit' ? 1 : 'fit'));
  $('#copy').addEventListener('click', copyImage);
  document.querySelectorAll('[data-save]').forEach((b) => {
    b.classList.toggle('default', b.dataset.save === settings.saveFormat);
    b.addEventListener('click', () => save(b.dataset.save));
  });
  $('#help-open').addEventListener('click', () => $('#help').showModal());

  workspace.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !base) return;
      e.preventDefault();
      zoomStep(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
  window.addEventListener('resize', () => base && zoom === 'fit' && applyZoom());
  window.addEventListener('beforeunload', (e) => {
    if (unsaved) e.preventDefault();
  });
  syncStylebar();
}

function setTool(next) {
  if (editing) commitText();
  tool = next;
  document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
  stage.dataset.tool = tool;
  overlay.style.cursor = '';
  // Picking a drawing tool starts something new, so let go of the current selection.
  if (tool !== 'select') select(null);
  syncStylebar();
}

// Changes the current style, and the selected annotation's style if there is one.
// `preview` is true while the colour picker is being dragged: those changes share one undo step.
let previewingStyle = false;
function setStyle(patch, preview = false) {
  Object.assign(style, patch);
  const s = selected() || editing?.shape;
  if (s) {
    const relevant = Object.fromEntries(
      Object.entries(patch).filter(([k]) => (k === 'fill' ? FILL_TYPES.has(s.type) : !(k === 'size' && s.type === 'blur'))),
    );
    if (Object.entries(relevant).some(([k, v]) => s[k] !== v)) {
      const before = bounds(s);
      if (editing?.shape === s) {
        Object.assign(s, relevant);
        layoutTextEditor();
      } else {
        if (!previewingStyle) pushUndo(snapshot());
        Object.assign(s, relevant);
        render(union(before, bounds(s)));
        drawOverlay();
      }
    }
  }
  previewingStyle = preview && !!s && editing?.shape !== s;
  syncStylebar();
}

function syncStylebar() {
  document.querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === style.color)));
  const custom = ![...document.querySelectorAll('[data-color]')].some((b) => b.dataset.color === style.color);
  $('.swatch.custom').setAttribute('aria-pressed', String(custom));
  document.querySelectorAll('[data-size]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.size === style.size)));
  $('#fill').setAttribute('aria-pressed', String(style.fill));
  const s = selected();
  const fillTarget = s ? s.type : tool;
  stylebar.classList.toggle('show-fill', FILL_TYPES.has(fillTarget));
  stylebar.classList.toggle('has-selection', !!s);
  stylebar.classList.toggle('crop-mode', tool === 'crop');
}

// ---- Keyboard ----

function setupKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if ($('#help').open) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && key === 'v') return; // handled by the paste event
    if (!base) return;

    if (mod && key === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && key === 's') {
      e.preventDefault();
      save(settings.saveFormat);
    } else if (mod && key === 'c' && !window.getSelection()?.toString()) {
      e.preventDefault();
      copyImage();
    } else if (mod && (key === '=' || key === '+')) {
      e.preventDefault();
      zoomStep(1);
    } else if (mod && key === '-') {
      e.preventDefault();
      zoomStep(-1);
    } else if (mod && key === '0') {
      e.preventDefault();
      applyZoom('fit');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selected()) {
        e.preventDefault();
        deleteSelected();
      }
    } else if (e.key === 'Escape') {
      if (selected()) select(null);
      else setTool('select');
    } else if (e.key.startsWith('Arrow') && selected()) {
      e.preventDefault();
      const step = screenPx(e.shiftKey ? 10 : 1);
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const s = selected();
      const before = bounds(s);
      commitChange(() => moveShape(s, dx, dy));
      render(union(before, bounds(s)));
      drawOverlay();
    } else if (e.key === '?') {
      $('#help').showModal();
    } else if (!mod && !e.altKey && TOOL_KEYS[key]) {
      setTool(TOOL_KEYS[key]);
    }
  });
}

// ---- Opening images (no capture) ----

function setupEmptyState() {
  const drop = $('#drop');
  const file = $('#file');
  $('#choose-file').addEventListener('click', () => file.click());
  file.addEventListener('change', () => openImageFile(file.files[0]));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    openImageFile(e.dataTransfer.files[0]);
  });
  document.addEventListener('paste', (e) => {
    if (document.body.dataset.state !== 'empty') return;
    const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
    if (item) openImageFile(item.getAsFile());
    else toast('The clipboard has no image. Copy an image first.');
  });
}

// ---- Saving ----

function toBlob(type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the image is too large to export'))), type, quality),
  );
}

async function save(kind, extraMessage = '') {
  if (!base) return;
  if (editing) commitText();
  const button = document.querySelector(`[data-save="${kind}"]`);
  button.disabled = true;
  try {
    const quality = settings.jpgQuality / 100;
    let blob;
    if (kind === 'png') blob = await toBlob('image/png');
    else if (kind === 'jpg') blob = await toBlob('image/jpeg', quality);
    else {
      toast('Making PDF…');
      blob = await canvasToPdf(canvas, { pageSize: settings.pdfPageSize, quality, cssWidth: naturalWidth() });
    }
    download(blob, kind);
    unsaved = false;
    toast(`Saved as ${kind.toUpperCase()}. ${extraMessage}`.trim());
  } catch (err) {
    toast(`Not saved: ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

function download(blob, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName(ext);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

function fileName(ext) {
  const d = new Date(meta.takenAt);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  const title = meta.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${title || 'Screenshot'} ${stamp}.${ext}`;
}

async function copyImage() {
  if (!base) return;
  if (editing) commitText();
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob('image/png') })]);
    unsaved = false;
    toast('Copied to clipboard');
  } catch (err) {
    toast(`Not copied: ${err.message}`);
  }
}

// ---- Helpers ----

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function normBox(b) {
  return {
    x: Math.min(b.x, b.x + b.w),
    y: Math.min(b.y, b.y + b.h),
    w: Math.abs(b.w),
    h: Math.abs(b.h),
  };
}

function inBox(p, box, tol) {
  const b = normBox(box);
  return p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol;
}

function roundOut(b) {
  const x = Math.floor(b.x), y = Math.floor(b.y);
  return { x, y, w: Math.ceil(b.x + b.w) - x, h: Math.ceil(b.y + b.h) - y };
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function union(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
