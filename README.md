# Capture and Annotate

A Chrome extension to capture a selected area, the visible screen or a full scrolling page, make quick edits, and save the result as **PNG, JPG or PDF**. It works offline, with no account and no tracking.

## Features

- **Select area** with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> on Mac). Drag to select, press <kbd>Enter</kbd> for the whole screen or <kbd>Esc</kbd> to cancel.
- **Visible part** and **Full page** from the toolbar popup. Shortcuts for these can be set at `chrome://extensions/shortcuts`.
- Full-page capture scrolls the page and stitches the screenshots together. Sticky headers appear only once.
- **Editor tools:** crop, pen, highlighter, rectangle, arrow, text and blur (pixelate, for hiding private info). It also has undo/redo, 6 colours and 3 sizes.
- **Export:** PNG, JPG, a PDF with long pages split across A4 pages, or copy to the clipboard.

Editor shortcuts: <kbd>C</kbd> crop · <kbd>P</kbd> pen · <kbd>H</kbd> highlight · <kbd>R</kbd> rectangle · <kbd>A</kbd> arrow · <kbd>T</kbd> text · <kbd>B</kbd> blur · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>S</kbd> save PNG · <kbd>Ctrl</kbd>+<kbd>C</kbd> copy.

## Try it locally

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin Capture and Annotate to the toolbar, open any website and press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>.

After changing the code, click the reload icon on the Capture and Annotate card in `chrome://extensions`.

## Project layout

```
manifest.json          Extension manifest (MV3)
src/background.js      Service worker: shortcuts, capturing, full-page scrolling
src/inject/select.js   Area-selection overlay injected into the page
src/popup/             Toolbar popup
src/editor/            Editor page (canvas tools, saving)
src/lib/pdf.js         Small built-in PDF writer (no dependencies)
src/lib/store.js       IndexedDB hand-off from service worker to editor
scripts/make-icons.py  Regenerates icons/ (needs Pillow)
scripts/package.sh     Builds the Web Store zip into dist/
test/pdf.test.mjs      Checks generated PDFs with qpdf
```

No build step and no third-party code. Plain JavaScript runs as-is, which keeps Web Store review simple.

## Publishing to the Chrome Web Store

1. Run `scripts/package.sh` to create `dist/capture-and-annotate-<version>.zip`.
2. Register at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). There's a one-time US$5 fee.
3. Upload the zip and fill in the listing. You'll need at least one 1280×800 screenshot, a 440×280 promo tile and the 128px icon.
4. **Privacy tab:** state that no user data is collected, explain the two permissions (the wording is in `PRIVACY.md`), and link to a public copy of `PRIVACY.md` (for example on GitHub).
5. Bump `version` in `manifest.json` for every update.

## Known limits

- Chrome blocks extensions on `chrome://` pages, the Chrome Web Store and other extensions' pages. The toolbar icon shows a red **!** there.
- Full-page capture scrolls the main page. Apps that scroll inside an inner panel (Gmail, Google Docs, some dashboards) only capture what is visible.
- Pages taller than Chrome's canvas limit (about 32,000 px) are scaled down to fit.
