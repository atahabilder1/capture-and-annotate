import { getCapture } from '../lib/store.js';
import { canvasToPdf } from '../lib/pdf.js';
import { getSettings } from '../lib/settings.js';

// Chrome/Firefox canvas limits; very long pages are scaled down to fit.
const MAX_SIDE = 32767;
const MAX_AREA = 200_000_000;
const HISTORY_LIMIT = 100;
// Size levels 1–10, in CSS pixels of the captured page; multiplied by `scale` for image pixels.
const STROKES = [1, 2, 3, 4, 5, 6, 8, 10, 13, 16];
const FONTS = [12, 14, 17, 20, 24, 28, 34, 42, 52, 64];
const RADII = [9, 10, 12, 14, 16, 18, 21, 24, 28, 32];
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
const BOX_TYPES = new Set(['rect', 'ellipse', 'blur', 'hlbox', 'spotlight', 'magnify']);
const TEXT_TYPES = new Set(['text', 'callout']);
// The style options each annotation type uses. The style bar shows exactly these.
const OPTIONS = {
  pen: ['color', 'size', 'opacity', 'dash', 'shadow'],
  brush: ['color', 'size'],
  highlight: ['color', 'size'],
  hlbox: ['color'],
  line: ['color', 'size', 'opacity', 'dash', 'shadow'],
  arrow: ['color', 'size', 'opacity', 'arrow', 'heads', 'dash', 'shadow'],
  rect: ['color', 'size', 'opacity', 'fill', 'dash', 'shadow'],
  ellipse: ['color', 'size', 'opacity', 'fill', 'dash', 'shadow'],
  text: ['color', 'size', 'opacity', 'fill', 'shadow'],
  callout: ['color', 'size', 'fill', 'shadow'],
  step: ['color', 'size', 'shadow'],
  stamp: ['stamp', 'color', 'size', 'shadow'],
  blur: ['blur', 'size'],
  spotlight: ['spot'],
  magnify: ['zoom'],
};
const DEFAULT_STYLE = {
  color: '#e5383b', size: 4, opacity: 1, fill: 'none', dash: 'solid', arrow: 'classic', heads: 'end',
  hlmode: 'free', blur: 'pixelate', spot: 'rect', zoom: 2, stamp: 'check', shadow: false,
};
const TOOL_DEFAULTS = {
  highlight: { color: '#ffd43b' },
  brush: { size: 5 },
  text: { size: 5 },
  callout: { fill: 'solid' },
  stamp: { size: 5 },
  blur: { size: 5, color: '#1b2433' },
};
// Tools that keep their own colour instead of sharing the last colour picked.
const OWN_COLOR = new Set(['highlight', 'blur']);
const TOOL_KEYS = {
  v: 'select', p: 'pen', k: 'brush', h: 'highlight', l: 'line', a: 'arrow', r: 'rect', e: 'ellipse',
  t: 'text', q: 'callout', n: 'step', s: 'stamp', b: 'blur', f: 'spotlight', m: 'magnify', x: 'eraser', c: 'crop',
};
// Stamp glyphs on a 24×24 grid, drawn on a coloured badge.
const STAMPS = {
  check: { label: 'Tick', d: 'M7.6 12.3l3 3 5.8-6.2' },
  cross: { label: 'Cross', d: 'M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8' },
  alert: { label: 'Exclamation mark', d: 'M12 6.9v6.3M12 16.9v.2' },
  question: { label: 'Question mark', d: 'M9.4 9.6a2.7 2.7 0 1 1 3.8 2.5c-.8.4-1.2.9-1.2 1.7v.4M12 17v.2' },
  info: { label: 'Info', d: 'M12 11v6M12 7.2v.2' },
  star: { label: 'Star', d: 'M12 6.2l1.8 3.7 4 .6-2.9 2.8.7 4L12 15.4l-3.6 1.9.7-4-2.9-2.8 4-.6z', filled: true },
  heart: { label: 'Heart', d: 'M12 17.6s-5.6-3.3-5.6-7.3a3 3 0 0 1 5.6-1.5 3 3 0 0 1 5.6 1.5c0 4-5.6 7.3-5.6 7.3z', filled: true },
};
const FONT_FAMILY = '"Instrument Sans", system-ui, sans-serif';
const INK = '#1b2433';
const PREFS_KEY = 'editor-style';

const $ = (sel) => document.querySelector(sel);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const stage = $('#stage');
const workspace = $('#workspace');
const stylebar = $('#stylebar');
const measureCtx = document.createElement('canvas').getContext('2d');
const stampPaths = new Map();

let settings;
let meta = { title: 'Screenshot', takenAt: Date.now() };
let base = null; // the captured image, never modified
let scale = 1; // image pixels per CSS pixel of the captured page
let doc = { crop: null, shapes: [] }; // shapes use base-image coordinates
let nextId = 1;
let tool = 'select';
const prefs = loadPrefs(); // last style used with each tool, kept between sessions
let style = { ...DEFAULT_STYLE };
let selectedId = null;
let hoverId = null; // annotation under the eraser
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
    // An inner scrolling panel keeps only its own area of each tile; a scrolled page keeps all of it.
    const clip = c.clip
      ? {
          x: clamp(Math.round(c.clip.x * scale), 0, first.width - 1),
          y: clamp(Math.round(c.clip.y * scale), 0, first.height - 1),
          w: Math.round(c.clip.width * scale),
          h: Math.round(c.clip.height * scale),
        }
      : { x: 0, y: 0, w: first.width, h: first.height };
    clip.w = clamp(clip.w, 1, first.width - clip.x);
    clip.h = clamp(clip.h, 1, first.height - clip.y);
    const width = clip.w;
    const height = Math.round(c.tiles.at(-1).y * scale) + clip.h;
    const fit = Math.min(1, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_AREA / (width * height)));
    out.width = Math.floor(width * fit);
    out.height = Math.floor(height * fit);
    c.tiles.forEach((t, i) => {
      octx2.drawImage(images[i], clip.x, clip.y, clip.w, clip.h, 0, Math.round(t.y * scale * fit), clip.w * fit, clip.h * fit);
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
  return doc.crop || baseRect();
}

function baseRect() {
  return { x: 0, y: 0, w: base.width, h: base.height };
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
  drawSpotlights(area);
  let step = 0;
  for (const s of doc.shapes) {
    if (s.type === 'step') step++;
    if (s.type === 'spotlight' || editing?.shape === s) continue;
    if (dirty && !intersect(bounds(s), area)) continue;
    drawShape(ctx, s, step);
  }
  ctx.restore();
}

// Spotlights dim the whole image except their own areas, under every other annotation.
function drawSpotlights(area) {
  const spots = doc.shapes.filter((s) => s.type === 'spotlight');
  if (!spots.length) return;
  ctx.save();
  ctx.fillStyle = 'rgba(12, 16, 24, 0.6)';
  ctx.fillRect(area.x, area.y, area.w, area.h);
  for (const s of spots) {
    ctx.save();
    spotPath(ctx, s);
    ctx.clip();
    ctx.drawImage(base, area.x, area.y, area.w, area.h, area.x, area.y, area.w, area.h);
    ctx.restore();
  }
  ctx.restore();
}

function spotPath(c, s, begin = true) {
  const b = normBox(s);
  if (begin) c.beginPath();
  if (s.spot === 'ellipse') c.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
  else c.roundRect(b.x, b.y, b.w, b.h, Math.min(6 * scale, b.w / 2, b.h / 2));
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
    const b = normBox(d);
    if (d.type === 'crop') {
      dimOutside(v, (c) => c.rect(b.x, b.y + b.h, b.w, -b.h)); // opposite winding cuts a hole
      drawFrame(b, true);
    } else if (d.type === 'spotlight') {
      if (!doc.shapes.some((s) => s.type === 'spotlight')) dimOutside(v, (c) => spotPath(c, { ...d, ...b }, false));
      drawFrame(b, false);
    } else if (d.type === 'blur' && d.blur !== 'redact') {
      octx.fillStyle = 'rgba(123, 133, 151, 0.35)';
      octx.fillRect(b.x, b.y, b.w, b.h);
      drawFrame(b, false);
    } else if (d.type === 'callout') {
      drawShape(octx, { ...d, text: 'Text' });
    } else {
      drawShape(octx, BOX_TYPES.has(d.type) ? { ...d, ...b } : d, countSteps() + 1);
    }
  }

  // While typing in a callout, the bubble is drawn here and the text box sits on top of it.
  if (editing?.shape.type === 'callout') drawShape(octx, { ...editing.shape, text: editing.el.value || ' ' }, 0, true);

  const sel = selected();
  if (sel && !editing) {
    drawFrame(shapeBox(sel), true);
    for (const h of handles(sel)) drawHandle(h);
  }
  const hover = tool === 'eraser' && !action && doc.shapes.find((s) => s.id === hoverId);
  if (hover) drawFrame(shapeBox(hover), false, '#e5383b');
}

function dimOutside(v, addHole) {
  octx.fillStyle = 'rgba(18, 22, 29, 0.5)';
  octx.beginPath();
  octx.rect(v.x, v.y, v.w, v.h);
  addHole(octx);
  octx.fill('evenodd');
}

function drawFrame(b, corners, color) {
  const px = screenPx(1);
  octx.save();
  octx.lineWidth = color ? px * 1.5 : px;
  octx.strokeStyle = color || 'rgba(47, 76, 221, 0.7)';
  if (color) octx.setLineDash([px * 5, px * 4]);
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
  octx.arc(h.x, h.y, screenPx(h.name === 'mid' ? 4.5 : 5.5), 0, Math.PI * 2);
  octx.fillStyle = h.name === 'mid' ? '#2f4cdd' : '#fff';
  octx.fill();
  octx.lineWidth = screenPx(2);
  octx.strokeStyle = h.name === 'mid' ? '#fff' : '#2f4cdd';
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

function level(table, s) {
  return table[clamp(Math.round(s.size ?? 4), 1, 10) - 1];
}

function lineWidth(s) {
  const w = level(STROKES, s) * scale;
  if (s.type === 'highlight') return w * 5;
  if (s.type === 'brush') return w * 1.8;
  return w;
}

function fontPx(s) {
  return level(FONTS, s) * scale;
}

function stepRadius(s) {
  return level(RADII, s) * scale * (s.type === 'stamp' ? 1.2 : 1);
}

function contrastColor(hex) {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? INK : '#ffffff';
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Blends `hex` toward white; `t` is how much white.
function tint(hex, t) {
  return `rgb(${rgb(hex).map((v) => Math.round(v + (255 - v) * t)).join(' ')})`;
}

function textColors(s) {
  const fill = s.fill || 'none';
  if (s.type === 'callout') {
    if (fill === 'solid') return { fg: contrastColor(s.color), bg: s.color };
    return { fg: INK, bg: fill === 'tint' ? tint(s.color, 0.82) : '#ffffff', border: s.color };
  }
  if (fill === 'solid') return { fg: contrastColor(s.color), bg: s.color };
  if (fill === 'tint') return { fg: INK, bg: tint(s.color, 0.8) };
  return { fg: s.color, bg: null };
}

function textLayout(s) {
  const size = fontPx(s);
  measureCtx.font = `600 ${size}px ${FONT_FAMILY}`;
  const lines = s.text.split('\n');
  const lineHeight = size * 1.25;
  const pad = s.type === 'callout' ? size * 0.55 : s.fill && s.fill !== 'none' ? size * 0.35 : 0;
  const width = Math.max(size * (s.type === 'callout' ? 1.5 : 0.5), ...lines.map((l) => measureCtx.measureText(l).width));
  return { size, lines, lineHeight, pad, box: { x: s.x, y: s.y, w: width + pad * 2, h: lines.length * lineHeight + pad * 2 } };
}

function applyDash(c, s, w) {
  if (s.dash === 'dashed') {
    c.setLineDash([w * 2.5, w * 2]);
    c.lineCap = 'butt';
  } else if (s.dash === 'dotted') {
    c.setLineDash([0.001, w * 2]);
    c.lineCap = 'round';
  }
}

function applyShadow(c) {
  c.shadowColor = 'rgba(12, 16, 24, 0.4)';
  c.shadowBlur = 8 * scale;
  c.shadowOffsetY = 2 * scale;
}

// Traces a smooth curve through freehand points.
function tracePoints(c, pts) {
  c.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) return c.lineTo(pts[0].x + 0.1, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    c.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
  }
  c.lineTo(pts.at(-1).x, pts.at(-1).y);
}

function drawShape(c, s, stepNumber, hideText = false) {
  c.save();
  c.strokeStyle = s.color;
  c.fillStyle = s.color;
  c.globalAlpha = s.opacity ?? 1;
  c.lineWidth = lineWidth(s);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (s.shadow) applyShadow(c);
  switch (s.type) {
    case 'pen':
      applyDash(c, s, c.lineWidth);
      c.beginPath();
      tracePoints(c, s.points);
      c.stroke();
      break;
    case 'highlight':
      c.globalAlpha = 0.4;
      c.lineCap = 'square';
      if (c === ctx) c.globalCompositeOperation = 'multiply';
      c.beginPath();
      tracePoints(c, s.points);
      c.stroke();
      break;
    case 'hlbox': {
      const b = normBox(s);
      c.globalAlpha = 0.4;
      if (c === ctx) c.globalCompositeOperation = 'multiply';
      c.fillRect(b.x, b.y, b.w, b.h);
      break;
    }
    case 'brush':
      drawBrush(c, s);
      break;
    case 'line':
    case 'arrow':
      drawArrow(c, s);
      break;
    case 'rect':
    case 'ellipse': {
      const b = normBox(s);
      c.beginPath();
      if (s.type === 'rect') c.roundRect(b.x, b.y, b.w, b.h, Math.min(c.lineWidth, b.w / 2, b.h / 2));
      else c.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      if (s.fill === 'solid' || s.fill === 'tint') {
        const alpha = c.globalAlpha;
        c.globalAlpha = alpha * (s.fill === 'solid' ? 1 : 0.22);
        c.fill();
        c.globalAlpha = alpha;
        c.shadowColor = 'transparent';
      }
      applyDash(c, s, c.lineWidth);
      c.stroke();
      break;
    }
    case 'blur':
      drawBlur(c, s);
      break;
    case 'magnify':
      drawMagnifier(c, s);
      break;
    case 'step':
    case 'stamp': {
      const r = stepRadius(s);
      c.beginPath();
      c.arc(s.x, s.y, r, 0, Math.PI * 2);
      c.fill();
      c.shadowColor = 'transparent';
      const fg = contrastColor(s.color);
      c.lineWidth = Math.max(1.5, r * 0.16);
      c.strokeStyle = fg;
      c.stroke();
      c.fillStyle = fg;
      if (s.type === 'step') {
        c.font = `700 ${r * 1.15}px ${FONT_FAMILY}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(stepNumber), s.x, s.y + r * 0.06);
      } else {
        const glyph = STAMPS[s.stamp] || STAMPS.check;
        c.translate(s.x - r, s.y - r);
        c.scale((r * 2) / 24, (r * 2) / 24);
        c.lineWidth = 2.5;
        if (glyph.filled) c.fill(stampPath(glyph));
        else c.stroke(stampPath(glyph));
      }
      break;
    }
    case 'text':
      drawText(c, s);
      break;
    case 'callout':
      drawCallout(c, s, hideText);
      break;
  }
  c.restore();
}

function stampPath(glyph) {
  if (!stampPaths.has(glyph)) stampPaths.set(glyph, new Path2D(glyph.d));
  return stampPaths.get(glyph);
}

// Brush strokes vary in width: thinner when moving fast, or with light pen pressure.
function drawBrush(c, s) {
  const pts = s.points;
  const w = lineWidth(s);
  if (pts.length < 3) {
    c.beginPath();
    c.lineWidth = w * (pts[0].w ?? 1);
    tracePoints(c, pts);
    c.stroke();
    return;
  }
  let from = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const to = i < pts.length - 1 ? { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 } : pts[i];
    c.beginPath();
    c.moveTo(from.x, from.y);
    c.quadraticCurveTo(pts[i].x, pts[i].y, to.x, to.y);
    c.lineWidth = w * (pts[i].w ?? 1);
    c.stroke();
    from = to;
  }
}

// Lines and arrows can be curved by a control point (cx, cy).
function curve(s) {
  return { a: { x: s.x1, y: s.y1 }, b: { x: s.x2, y: s.y2 }, k: 'cx' in s ? { x: s.cx, y: s.cy } : null };
}

function pointOn(s, t) {
  const { a, b, k } = curve(s);
  if (!k) return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * k.x + t * t * b.x, y: u * u * a.y + 2 * u * t * k.y + t * t * b.y };
}

function curveSamples(s) {
  if (!('cx' in s)) return [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];
  return Array.from({ length: 33 }, (_, i) => pointOn(s, i / 32));
}

function unit(dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

function arrowHeads(s) {
  return s.type === 'line' ? 'none' : s.heads || 'end';
}

function drawArrow(c, s) {
  if (s.type === 'arrow' && s.arrow === 'tapered') return drawTaperedArrow(c, s);
  const w = c.lineWidth;
  const { a, b, k } = curve(s);
  const heads = arrowHeads(s);
  const head = Math.max(12 * scale, w * 3.6);
  const dEnd = unit(b.x - (k || a).x, b.y - (k || a).y);
  const dStart = unit(a.x - (k || b).x, a.y - (k || b).y);
  // Stop the shaft short so its round cap doesn't poke through the arrowhead.
  const e1 = heads === 'both' ? { x: a.x - dStart.x * head * 0.7, y: a.y - dStart.y * head * 0.7 } : a;
  const e2 = heads !== 'none' ? { x: b.x - dEnd.x * head * 0.7, y: b.y - dEnd.y * head * 0.7 } : b;
  c.save();
  applyDash(c, s, w);
  c.beginPath();
  c.moveTo(e1.x, e1.y);
  if (k) c.quadraticCurveTo(k.x, k.y, e2.x, e2.y);
  else c.lineTo(e2.x, e2.y);
  c.stroke();
  c.restore();
  if (heads !== 'none') drawArrowhead(c, b, dEnd, head, w);
  if (heads === 'both') drawArrowhead(c, a, dStart, head, w);
}

function drawArrowhead(c, tip, d, head, w) {
  const angle = Math.atan2(d.y, d.x);
  c.beginPath();
  c.moveTo(tip.x, tip.y);
  c.lineTo(tip.x - head * Math.cos(angle - Math.PI / 7), tip.y - head * Math.sin(angle - Math.PI / 7));
  c.lineTo(tip.x - head * Math.cos(angle + Math.PI / 7), tip.y - head * Math.sin(angle + Math.PI / 7));
  c.closePath();
  c.lineWidth = Math.max(1, w * 0.5);
  c.fill();
  c.stroke();
}

// A solid arrow that widens from a thin tail to a large head.
function drawTaperedArrow(c, s) {
  const w = lineWidth(s);
  const pts = curveSamples(s);
  const lengths = [0];
  for (let i = 1; i < pts.length; i++) lengths.push(lengths[i - 1] + dist(pts[i - 1], pts[i]));
  const total = lengths.at(-1);
  if (total < 1) return;
  const both = s.heads === 'both';
  const head = Math.min(total * (both ? 0.4 : 0.6), Math.max(16 * scale, w * 4.6));
  const halfHead = head * 0.6;
  const at = (len) => {
    const i = clamp(lengths.findIndex((l) => l >= len), 1, pts.length - 1);
    const t = (len - lengths[i - 1]) / Math.max(1e-6, lengths[i] - lengths[i - 1]);
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t, len };
  };
  const startCut = both ? head : 0;
  const endCut = total - head;
  const shaft = [at(startCut), ...pts.map((p, i) => ({ ...p, len: lengths[i] })).filter((p) => p.len > startCut && p.len < endCut), at(endCut)];
  const half = (len) => (both ? w * 1.1 : w * (0.3 + 1.1 * (len / total)));
  const left = [];
  const right = [];
  shaft.forEach((p, i) => {
    const prev = shaft[Math.max(0, i - 1)];
    const next = shaft[Math.min(shaft.length - 1, i + 1)];
    const d = unit(next.x - prev.x, next.y - prev.y);
    const h = half(p.len);
    left.push({ x: p.x - d.y * h, y: p.y + d.x * h });
    right.push({ x: p.x + d.y * h, y: p.y - d.x * h });
  });
  const tipEnd = { x: s.x2, y: s.y2 };
  const baseEnd = shaft.at(-1);
  const dEnd = unit(tipEnd.x - baseEnd.x, tipEnd.y - baseEnd.y);
  c.beginPath();
  left.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  c.lineTo(baseEnd.x - dEnd.y * halfHead, baseEnd.y + dEnd.x * halfHead);
  c.lineTo(tipEnd.x, tipEnd.y);
  c.lineTo(baseEnd.x + dEnd.y * halfHead, baseEnd.y - dEnd.x * halfHead);
  for (let i = right.length - 1; i >= 0; i--) c.lineTo(right[i].x, right[i].y);
  if (both) {
    const tip = { x: s.x1, y: s.y1 };
    const b0 = shaft[0];
    const d0 = unit(b0.x - tip.x, b0.y - tip.y); // forward direction at the start
    c.lineTo(b0.x + d0.y * halfHead, b0.y - d0.x * halfHead);
    c.lineTo(tip.x, tip.y);
    c.lineTo(b0.x - d0.y * halfHead, b0.y + d0.x * halfHead);
  }
  c.closePath();
  c.lineWidth = Math.max(1, w * 0.3);
  c.fill();
  c.stroke();
}

function drawText(c, s) {
  const t = textLayout(s);
  const colors = textColors(s);
  c.font = `600 ${t.size}px ${FONT_FAMILY}`;
  c.textBaseline = 'top';
  if (colors.bg) {
    c.beginPath();
    c.roundRect(t.box.x, t.box.y, t.box.w, t.box.h, t.size * 0.22);
    c.fillStyle = colors.bg;
    c.fill();
    c.shadowColor = 'transparent';
  } else {
    // A soft halo keeps text readable on busy screenshots.
    c.lineWidth = t.size * 0.18;
    c.strokeStyle = contrastColor(s.color) === '#ffffff' ? 'rgba(255,255,255,0.9)' : 'rgba(27,36,51,0.85)';
  }
  c.fillStyle = colors.fg;
  t.lines.forEach((line, i) => {
    const y = s.y + t.pad + i * t.lineHeight + t.size * 0.1;
    if (!colors.bg) c.strokeText(line, s.x + t.pad, y);
    c.fillText(line, s.x + t.pad, y);
  });
}

// A speech bubble whose tail points at (tx, ty).
function drawCallout(c, s, hideText) {
  const t = textLayout(s);
  const colors = textColors(s);
  const box = t.box;
  c.beginPath();
  c.roundRect(box.x, box.y, box.w, box.h, Math.min(t.size * 0.5, box.h / 2));
  const tail = calloutTail(s, t);
  if (tail) {
    // Wind the tail the same way as the box so the two fill as one shape.
    const [p, q, tip] = tail;
    const clockwise = (q.x - p.x) * (tip.y - p.y) - (tip.x - p.x) * (q.y - p.y) > 0;
    const [m, n] = clockwise ? [p, q] : [q, p];
    c.moveTo(m.x, m.y);
    c.lineTo(n.x, n.y);
    c.lineTo(tip.x, tip.y);
    c.closePath();
  }
  if (colors.border) {
    // Stroke at double width, then fill: the fill covers the inner half and the tail's inner edges.
    c.lineWidth = Math.max(2 * scale, t.size * 0.09) * 2;
    c.strokeStyle = colors.border;
    c.stroke();
    c.shadowColor = 'transparent';
  }
  c.fillStyle = colors.bg;
  c.fill();
  c.shadowColor = 'transparent';
  if (hideText) return;
  c.font = `600 ${t.size}px ${FONT_FAMILY}`;
  c.textBaseline = 'top';
  c.fillStyle = colors.fg;
  t.lines.forEach((line, i) => c.fillText(line, box.x + t.pad, box.y + t.pad + i * t.lineHeight + t.size * 0.1));
}

function calloutTail(s, t = textLayout(s)) {
  const box = t.box;
  const tip = { x: s.tx, y: s.ty };
  if (inBox(tip, box, 0)) return null;
  const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const d = unit(tip.x - center.x, tip.y - center.y);
  const half = Math.min(t.size * 0.55, box.w / 3, box.h / 3);
  return [
    { x: center.x - d.y * half, y: center.y + d.x * half },
    { x: center.x + d.y * half, y: center.y - d.x * half },
    tip,
  ];
}

function drawBlur(c, s) {
  const r = intersect(roundOut(normBox(s)), baseRect());
  if (!r) return;
  const mode = s.blur || 'pixelate';
  if (mode === 'redact') {
    c.fillRect(r.x, r.y, r.w, r.h);
    return;
  }
  const n = clamp(Math.round(s.size ?? 5), 1, 10);
  const key = `${mode},${n},${r.x},${r.y},${r.w},${r.h}`;
  let cached = blurCache.get(s);
  if (cached?.key !== key) {
    const img = document.createElement('canvas');
    if (mode === 'pixelate') {
      const block = Math.max(3, Math.round((3 + n * 1.6) * scale));
      img.width = Math.max(1, Math.ceil(r.w / block));
      img.height = Math.max(1, Math.ceil(r.h / block));
      img.getContext('2d').drawImage(base, r.x, r.y, r.w, r.h, 0, 0, img.width, img.height);
    } else {
      const radius = (1.5 + n * 1.4) * scale;
      // Include a margin of surrounding pixels so the edges blur evenly.
      const m = Math.ceil(radius * 2);
      const src = intersect({ x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 }, baseRect());
      img.width = r.w;
      img.height = r.h;
      const g = img.getContext('2d');
      g.filter = `blur(${radius}px)`;
      g.drawImage(base, src.x, src.y, src.w, src.h, src.x - r.x, src.y - r.y, src.w, src.h);
    }
    cached = { key, img };
    blurCache.set(s, cached);
  }
  c.imageSmoothingEnabled = mode !== 'pixelate';
  c.drawImage(cached.img, 0, 0, cached.img.width, cached.img.height, r.x, r.y, r.w, r.h);
}

// A round lens showing the image underneath enlarged.
function drawMagnifier(c, s) {
  const b = normBox(s);
  if (b.w < 1 || b.h < 1) return;
  const z = s.zoom || 2;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const ring = Math.max(2 * scale, Math.min(b.w, b.h) * 0.025);
  const lens = () => {
    c.beginPath();
    c.ellipse(cx, cy, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
  };
  c.save();
  applyShadow(c);
  c.shadowBlur = 14 * scale;
  lens();
  c.fillStyle = '#ffffff';
  c.fill();
  c.restore();
  c.save();
  lens();
  c.clip();
  c.imageSmoothingQuality = 'high';
  c.drawImage(base, cx - b.w / (2 * z), cy - b.h / (2 * z), b.w / z, b.h / z, b.x, b.y, b.w, b.h);
  c.restore();
  lens();
  c.lineWidth = ring;
  c.strokeStyle = '#ffffff';
  c.stroke();
}

// Box around the visible shape, used for selection and redraw areas.
function shapeBox(s) {
  switch (s.type) {
    case 'pen':
    case 'brush':
    case 'highlight':
      return pointsBox(s.points);
    case 'line':
    case 'arrow':
      return pointsBox(curveSamples(s));
    case 'step':
    case 'stamp': {
      const r = stepRadius(s);
      return { x: s.x - r, y: s.y - r, w: r * 2, h: r * 2 };
    }
    case 'text':
      return textLayout(s).box;
    case 'callout': {
      const box = textLayout(s).box;
      return union(box, { x: s.tx, y: s.ty, w: 0, h: 0 });
    }
    default:
      return normBox(s);
  }
}

function pointsBox(pts) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function bounds(s) {
  if (s.type === 'spotlight') return baseRect(); // it dims the whole image
  const b = shapeBox(s);
  let pad;
  switch (s.type) {
    case 'blur':
    case 'hlbox':
      pad = 2;
      break;
    case 'magnify':
      pad = 20 * scale + Math.min(b.w, b.h) * 0.03;
      break;
    case 'arrow':
      pad = Math.max(16 * scale, lineWidth(s) * 4.6);
      break;
    case 'text':
      pad = fontPx(s) * 0.2;
      break;
    case 'callout':
      pad = fontPx(s) * 0.2 + 4 * scale;
      break;
    case 'step':
    case 'stamp':
      pad = stepRadius(s) * 0.2;
      break;
    default:
      pad = lineWidth(s);
  }
  if (s.shadow) pad += 14 * scale;
  return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
}

function hitTest(s, p, tol) {
  const w = lineWidth(s) / 2 + tol;
  switch (s.type) {
    case 'pen':
    case 'brush':
    case 'highlight':
      return hitPolyline(s.points, p, w);
    case 'line':
    case 'arrow':
      return hitPolyline(curveSamples(s), p, s.arrow === 'tapered' ? w * 2 : w);
    case 'rect':
      return s.fill === 'solid' || s.fill === 'tint' ? inBox(p, s, tol) : inBox(p, s, w) && !inBox(p, s, -w);
    case 'ellipse': {
      const rx = Math.abs(s.w) / 2, ry = Math.abs(s.h) / 2;
      if (rx < 2 || ry < 2) return inBox(p, s, w);
      const b = normBox(s);
      const d = Math.hypot((p.x - b.x - rx) / rx, (p.y - b.y - ry) / ry);
      return s.fill === 'solid' || s.fill === 'tint' ? d <= 1 + w / Math.min(rx, ry) : Math.abs(d - 1) * Math.min(rx, ry) <= w;
    }
    case 'step':
    case 'stamp':
      return dist(p, s) <= stepRadius(s) + tol;
    case 'text':
      return inBox(p, textLayout(s).box, tol);
    case 'callout': {
      const t = textLayout(s);
      const tail = calloutTail(s, t);
      return inBox(p, t.box, tol) || (!!tail && distToSegment(p, tail[2], { x: t.box.x + t.box.w / 2, y: t.box.y + t.box.h / 2 }) <= t.size * 0.4 + tol);
    }
    case 'spotlight':
      // Only the edge, so clicks inside still reach what's underneath.
      return inBox(p, s, tol * 1.5) && !inBox(p, s, -tol * 1.5);
    default:
      return inBox(p, s, tol);
  }
}

function hitPolyline(pts, p, w) {
  return pts.some((q, i) => (i === 0 ? dist(p, q) : distToSegment(p, pts[i - 1], q)) <= w);
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
      { name: 'mid', ...pointOn(s, 0.5) },
    ];
  }
  if (s.type === 'callout') return [{ name: 'tip', x: s.tx, y: s.ty }];
  return [];
}

function moveShape(s, dx, dy) {
  if (s.points) s.points = s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
  else if ('x1' in s) Object.assign(s, { x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy });
  else Object.assign(s, { x: s.x + dx, y: s.y + dy });
  if ('cx' in s) Object.assign(s, { cx: s.cx + dx, cy: s.cy + dy });
  if ('tx' in s) Object.assign(s, { tx: s.tx + dx, ty: s.ty + dy });
}

function resizeShape(s, handle, p) {
  if (handle === 'p1') return Object.assign(s, { x1: p.x, y1: p.y });
  if (handle === 'p2') return Object.assign(s, { x2: p.x, y2: p.y });
  if (handle === 'tip') return Object.assign(s, { tx: p.x, ty: p.y });
  if (handle === 'mid') {
    // Dragging the middle bends the line; dropping it back near the straight middle straightens it.
    const mid = { x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 };
    if (dist(p, mid) < screenPx(6)) {
      delete s.cx;
      delete s.cy;
    } else {
      Object.assign(s, { cx: 2 * p.x - mid.x, cy: 2 * p.y - mid.y });
    }
    return;
  }
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
    for (const k of ['color', 'size', ...optionKeys(s.type, s)]) if (k in s) style[k] = s[k];
  } else {
    style = toolStyle(tool);
  }
  syncStylebar();
  drawOverlay();
}

// ---- Styles ----

function optionKeys(type, src) {
  const keys = OPTIONS[type] || [];
  if (type === 'blur' && src.blur === 'redact') return ['blur', 'color'];
  if (type === 'arrow' && src.arrow === 'tapered') return keys.filter((k) => k !== 'dash');
  return keys;
}

function typeForTool(t) {
  return t === 'highlight' && style.hlmode === 'box' ? 'hlbox' : t;
}

function newShape(type, extra) {
  const shape = { id: nextId++, type, color: style.color, size: style.size };
  for (const k of optionKeys(type, style)) shape[k] = style[k];
  return Object.assign(shape, extra);
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (p?.tools) return p;
  } catch {}
  return { color: DEFAULT_STYLE.color, tools: {} };
}

function toolStyle(t) {
  const s = { ...DEFAULT_STYLE, ...TOOL_DEFAULTS[t], ...prefs.tools[t] };
  if (!OWN_COLOR.has(t)) s.color = prefs.color;
  return s;
}

function rememberStyle(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'color' && !OWN_COLOR.has(tool)) prefs.color = v;
    else (prefs.tools[tool] ||= {})[k] = v;
  }
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
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
  overlay.addEventListener('pointerleave', () => {
    if (hoverId === null) return;
    hoverId = null;
    drawOverlay();
  });
  overlay.addEventListener('dblclick', (e) => {
    const s = topShapeAt(toBase(e));
    if (s && TEXT_TYPES.has(s.type)) {
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
    if (tool === 'text' || tool === 'callout') return;
  }
  const p = toBase(e);
  overlay.setPointerCapture(e.pointerId);

  const sel = selected();
  if (sel && tool !== 'crop' && tool !== 'eraser') {
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

  if (tool === 'eraser') {
    action = { kind: 'erase', before: snapshot(), changed: false };
    eraseAt(p);
    return;
  }

  if (tool === 'text') {
    const s = topShapeAt(p);
    if (s && TEXT_TYPES.has(s.type)) {
      select(s.id);
      startTextEdit(s);
    } else {
      select(null);
      startTextEdit(newShape('text', { x: p.x, y: p.y - fontPx(style) * 0.6, text: '' }));
    }
    return;
  }

  select(null);
  const type = typeForTool(tool);
  if (type === 'step' || type === 'stamp') {
    const s = newShape(type, { x: p.x, y: p.y });
    commitChange(() => doc.shapes.push(s));
    render(bounds(s));
    select(s.id);
    return;
  }

  let shape;
  if (type === 'pen' || type === 'highlight') shape = newShape(type, { points: [p] });
  else if (type === 'brush') shape = newShape(type, { points: [{ ...p, w: 0.45 }] });
  else if (type === 'line' || type === 'arrow') shape = newShape(type, { x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  else if (type === 'callout') {
    shape = newShape(type, { tx: p.x, ty: p.y, x: p.x, y: p.y, text: '' });
    placeCallout(shape, null);
  } else shape = newShape(type, { x: p.x, y: p.y, w: 0, h: 0 });
  action = { kind: 'draw', shape, start: p, end: null, lastTime: e.timeStamp };
  drawOverlay();
}

function onPointerMove(e) {
  if (!base) return;
  const p = toBase(e);
  if (!action) return updateHover(p);
  if (action.kind === 'erase') return eraseAt(p);

  if (action.kind === 'draw') {
    const s = action.shape;
    if (s.points) {
      // Coalesced events give smoother freehand lines when the pointer moves fast.
      for (const ev of e.getCoalescedEvents?.() || [e]) addPoint(s, toBase(ev), ev);
    } else if (s.type === 'callout') {
      action.end = p;
      placeCallout(s, dist(p, action.start) >= screenPx(12) ? p : null);
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

function addPoint(s, p, e) {
  const last = s.points.at(-1);
  const d = dist(last, p);
  if (d < screenPx(1.5)) return;
  if (s.type === 'brush') {
    let target;
    if (e.pointerType === 'pen' && e.pressure > 0) {
      target = 0.25 + e.pressure * 0.9;
    } else {
      const speed = d / screenPx(1) / Math.max(1, e.timeStamp - action.lastTime); // screen px per ms
      target = clamp(1.1 - speed * 0.3, 0.35, 1);
    }
    action.lastTime = e.timeStamp;
    p.w = last.w * 0.65 + target * 0.35;
  }
  s.points.push(p);
}

function onPointerUp() {
  if (!action) return;
  const a = action;
  action = null;
  if (a.kind === 'draw') finishDrawing(a);
  else if (a.changed && a.shape && BOX_TYPES.has(a.shape.type)) Object.assign(a.shape, normBox(a.shape));
  drawOverlay();
}

function finishDrawing(a) {
  const s = a.shape;
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
  if (s.type === 'callout') return startTextEdit(s);
  if (s.type === 'brush' && s.points.length > 2) {
    // Taper the end of the stroke.
    s.points.at(-1).w *= 0.4;
    s.points.at(-2).w *= 0.7;
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

// Puts the callout bubble at `p`, or, for a plain click, up and to the right of the tip.
function placeCallout(s, p) {
  const t = textLayout({ ...s, text: s.text || 'Text' });
  const gap = 40 * scale;
  const at = p || { x: s.tx + gap, y: s.ty - gap };
  s.x = at.x >= s.tx ? at.x : at.x - t.box.w;
  s.y = at.y - t.box.h / 2;
}

function eraseAt(p) {
  const s = topShapeAt(p);
  if (!s) return;
  if (!action.changed) {
    action.changed = true;
    pushUndo(action.before);
  }
  doc.shapes.splice(doc.shapes.indexOf(s), 1);
  if (selectedId === s.id) select(null);
  // Removing a step renumbers the ones after it, so redraw everything.
  render(s.type === 'step' ? undefined : bounds(s));
  drawOverlay();
}

function snapAngle(s) {
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  const len = dist({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
  s.x2 = s.x1 + Math.cos(snapped) * len;
  s.y2 = s.y1 + Math.sin(snapped) * len;
}

function updateHover(p) {
  if (tool === 'eraser') {
    const id = topShapeAt(p)?.id ?? null;
    if (id !== hoverId) {
      hoverId = id;
      drawOverlay();
    }
    return;
  }
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
  syncStylebar();
  drawOverlay();
  el.addEventListener('input', () => {
    shape.text = el.value;
    layoutTextEditor();
    if (shape.type === 'callout') drawOverlay();
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
  const colors = textColors(shape);
  Object.assign(el.style, {
    left: `${(shape.x - v.x) * ratio}px`,
    top: `${(shape.y - v.y) * ratio}px`,
    width: `${(t.box.w + t.size * 0.6) * ratio}px`,
    height: `${t.box.h * ratio}px`,
    fontSize: `${t.size * ratio}px`,
    padding: `${(t.pad + t.size * 0.1) * ratio}px ${t.pad * ratio}px 0`,
    color: colors.fg,
    // A callout's bubble is drawn on the overlay underneath.
    background: shape.type === 'text' && colors.bg ? colors.bg : 'transparent',
    borderRadius: `${t.size * 0.22 * ratio}px`,
    opacity: shape.opacity ?? 1,
  });
  if (shape.type === 'callout') drawOverlay();
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
  syncStylebar();
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

function duplicateSelected() {
  const s = selected();
  if (!s) return;
  const copy = structuredClone(s);
  copy.id = nextId++;
  moveShape(copy, screenPx(16), screenPx(16));
  commitChange(() => doc.shapes.push(copy));
  render(bounds(copy));
  select(copy.id);
}

function reorderSelected(toFront) {
  const s = selected();
  if (!s) return;
  const i = doc.shapes.indexOf(s);
  if (i === (toFront ? doc.shapes.length - 1 : 0)) return;
  commitChange(() => {
    doc.shapes.splice(i, 1);
    if (toFront) doc.shapes.push(s);
    else doc.shapes.unshift(s);
  });
  render(); // step numbers follow the order
  drawOverlay();
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

  const stamps = $('.stamps');
  for (const [name, glyph] of Object.entries(STAMPS)) {
    const b = document.createElement('button');
    b.dataset.val = name;
    b.title = glyph.label;
    b.setAttribute('aria-label', glyph.label);
    const svg = svgEl('svg', { viewBox: '0 0 24 24' });
    svg.append(svgEl('circle', { cx: 12, cy: 12, r: 11, class: 'badge' }), svgEl('path', { d: glyph.d, class: glyph.filled ? 'glyph filled' : 'glyph' }));
    b.append(svg);
    stamps.append(b);
  }
  document.querySelectorAll('.seg[data-opt]').forEach((group) =>
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-val]');
      if (!b) return;
      const v = b.dataset.val;
      setStyle({ [group.dataset.opt]: Number.isNaN(Number(v)) ? v : Number(v) });
    }),
  );
  $('#size').addEventListener('input', (e) => setStyle({ size: Number(e.target.value) }, true));
  $('#size').addEventListener('change', (e) => setStyle({ size: Number(e.target.value) }));
  $('#opacity').addEventListener('input', (e) => setStyle({ opacity: Number(e.target.value) / 100 }, true));
  $('#opacity').addEventListener('change', (e) => setStyle({ opacity: Number(e.target.value) / 100 }));
  $('#shadow').addEventListener('click', () => setStyle({ shadow: !style.shadow }));

  $('#delete').addEventListener('click', deleteSelected);
  $('#duplicate').addEventListener('click', duplicateSelected);
  $('#to-front').addEventListener('click', () => reorderSelected(true));
  $('#to-back').addEventListener('click', () => reorderSelected(false));
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

function svgEl(name, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function setTool(next) {
  if (editing) commitText();
  tool = next;
  hoverId = null;
  document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
  stage.dataset.tool = tool;
  overlay.style.cursor = '';
  // Picking a drawing tool starts something new, so let go of the current selection.
  if (tool !== 'select' || !selected()) select(null);
  else syncStylebar();
}

// Changes the current style, and the selected annotation's style if there is one.
// `preview` is true while a colour picker or slider is being dragged: those changes share one undo step.
let previewingStyle = false;
function setStyle(patch, preview = false) {
  Object.assign(style, patch);
  const s = selected() || editing?.shape;
  if (s) {
    const keys = new Set(['color', 'size', ...optionKeys(s.type, { ...s, ...patch })]);
    const relevant = Object.fromEntries(Object.entries(patch).filter(([k]) => keys.has(k)));
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
  // Styles picked while using a drawing tool become that tool's defaults.
  if (!['select', 'eraser', 'crop'].includes(tool)) rememberStyle(patch);
  previewingStyle = preview && !!s && editing?.shape !== s;
  syncStylebar();
}

// The options the style bar shows right now.
function barOptions() {
  const s = selected() || editing?.shape;
  if (s) return optionKeys(s.type, s);
  if (tool === 'eraser') return ['eraser-hint'];
  if (tool === 'select' || tool === 'crop') return [];
  const keys = optionKeys(typeForTool(tool), style);
  return tool === 'highlight' ? ['hlmode', ...keys] : keys;
}

function syncStylebar() {
  const keys = new Set(barOptions());
  stylebar.querySelectorAll('.opt').forEach((el) => (el.hidden = !keys.has(el.dataset.opt)));
  document.querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === style.color)));
  const custom = ![...document.querySelectorAll('[data-color]')].some((b) => b.dataset.color === style.color);
  $('.swatch.custom').setAttribute('aria-pressed', String(custom));
  if (custom) $('#custom-color').value = style.color;
  document.querySelectorAll('.seg[data-opt]').forEach((group) => {
    const value = String(style[group.dataset.opt]);
    group.querySelectorAll('button[data-val]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.val === value)));
  });
  $('#size').value = style.size;
  $('#size-out').textContent = style.size;
  $('#opacity').value = Math.round(style.opacity * 100);
  $('#opacity-out').textContent = `${Math.round(style.opacity * 100)}%`;
  $('#shadow').setAttribute('aria-pressed', String(!!style.shadow));
  const hasSelection = !!selected() && !editing;
  stylebar.classList.toggle('has-selection', hasSelection);
  stylebar.classList.toggle('crop-mode', tool === 'crop');
  stylebar.classList.toggle('is-empty', !keys.size && !hasSelection && tool !== 'crop');
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
    } else if (mod && key === 'd') {
      e.preventDefault();
      duplicateSelected();
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
    } else if ((e.key === '[' || e.key === ']') && selected()) {
      reorderSelected(e.key === ']');
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
