// Injected into the page to let the user drag out a capture area.
// Reports { rect, viewWidth } in CSS pixels to the service worker.
(() => {
  if (window.__capannotateSelecting) return;
  window.__capannotateSelecting = true;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .layer { position: fixed; inset: 0; cursor: crosshair; background: rgba(18, 22, 29, 0.42); }
      .layer.dragging { background: transparent; }
      .box { position: fixed; display: none; outline: 1px solid rgba(255, 255, 255, 0.85);
             box-shadow: 0 0 0 100vmax rgba(18, 22, 29, 0.42); pointer-events: none; }
      .corner { position: absolute; width: 14px; height: 14px; border: 0 solid #2f4cdd; }
      .tl { left: -4px; top: -4px; border-width: 3px 0 0 3px; }
      .tr { right: -4px; top: -4px; border-width: 3px 3px 0 0; }
      .bl { left: -4px; bottom: -4px; border-width: 0 0 3px 3px; }
      .br { right: -4px; bottom: -4px; border-width: 0 3px 3px 0; }
      .size { position: absolute; left: -4px; top: -32px; padding: 4px 8px; border-radius: 6px;
              font: 600 12px/1.2 system-ui, sans-serif; font-variant-numeric: tabular-nums;
              color: #fff; background: #2f4cdd; white-space: nowrap; }
      .hint { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); padding: 9px 16px;
              border-radius: 10px; font: 500 13px/1.3 system-ui, sans-serif; color: #e6e9ef;
              background: rgba(27, 33, 43, 0.92); box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.5);
              pointer-events: none; white-space: nowrap; }
      .hint b { color: #fff; font-weight: 600; }
    </style>
    <div class="layer"></div>
    <div class="box">
      <span class="corner tl"></span><span class="corner tr"></span>
      <span class="corner bl"></span><span class="corner br"></span>
      <span class="size"></span>
    </div>
    <div class="hint">Drag to select an area. <b>Enter</b> takes the whole screen, <b>Esc</b> cancels.</div>
  `;
  const layer = root.querySelector('.layer');
  const box = root.querySelector('.box');
  const size = root.querySelector('.size');
  const hint = root.querySelector('.hint');
  document.documentElement.appendChild(host);

  let start = null;
  let rect = null;

  const onDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    start = { x: e.clientX, y: e.clientY };
    layer.classList.add('dragging');
    hint.style.display = 'none';
  };

  const onMove = (e) => {
    if (!start) return;
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    rect = { x, y, width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) };
    Object.assign(box.style, {
      display: 'block',
      left: `${x}px`,
      top: `${y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    size.style.top = y < 36 ? '6px' : '-32px';
    size.style.left = y < 36 ? '6px' : '-4px';
  };

  const onUp = () => {
    if (!start) return;
    start = null;
    if (!rect || rect.width < 5 || rect.height < 5) {
      // A plain click: go back to waiting for a drag.
      layer.classList.remove('dragging');
      box.style.display = 'none';
      hint.style.display = '';
      rect = null;
      return;
    }
    finish(rect);
  };

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      finish({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    }
  };

  function cleanup() {
    layer.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    window.removeEventListener('keydown', onKey, true);
    host.remove();
    delete window.__capannotateSelecting;
  }

  function finish(selected) {
    cleanup();
    // Wait until the overlay is gone from the screen before the screenshot is taken.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'area-selected', rect: selected, viewWidth: window.innerWidth });
        }, 50),
      ),
    );
  }

  layer.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
  window.addEventListener('keydown', onKey, true);
})();
