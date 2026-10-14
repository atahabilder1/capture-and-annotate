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
      .layer { position: fixed; inset: 0; cursor: crosshair; background: rgba(15, 23, 42, 0.4); }
      .layer.dragging { background: transparent; }
      .box { position: fixed; display: none; border: 1.5px solid #fff; outline: 1px solid #2563eb;
             box-shadow: 0 0 0 100vmax rgba(15, 23, 42, 0.4); pointer-events: none; }
      .size { position: absolute; left: 0; top: -26px; padding: 3px 7px; border-radius: 4px;
              font: 12px/1.2 system-ui, sans-serif; color: #fff; background: #2563eb; white-space: nowrap; }
      .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 8px 14px;
              border-radius: 8px; font: 13px/1.3 system-ui, sans-serif; color: #fff;
              background: rgba(15, 23, 42, 0.85); pointer-events: none; }
    </style>
    <div class="layer"></div>
    <div class="box"><span class="size"></span></div>
    <div class="hint">Drag to select an area &nbsp;·&nbsp; Enter: whole screen &nbsp;·&nbsp; Esc: cancel</div>
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
    size.style.top = y < 30 ? '4px' : '-26px';
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
