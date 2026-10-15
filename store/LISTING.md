# Chrome Web Store listing

Everything to paste into the Developer Dashboard for **Capture and Annotate**. Each heading matches a field in the dashboard.

## Package

Upload `dist/capture-and-annotate-chrome-<version>.zip`, built with `node scripts/build.mjs`. Bump `version` in `manifest.json` for every update.

## Store listing tab

**Name** (taken from the manifest)
Capture and Annotate – Screenshot to PDF & Image

**Summary** (taken from the manifest, 132 characters at most)
Capture an area, a full page or any window. Annotate with arrows, text, steps and blur, then save as PNG, JPG or PDF.

**Category:** Productivity › Tools
**Language:** English

**Description**

```
Take a screenshot of anything in your browser, mark it up in seconds, and save it as PNG, JPG or PDF. Free, works offline, and needs no account.

CAPTURE
• Select area – drag over any part of the page (Ctrl+Shift+S, or ⌘+Shift+S on Mac)
• Visible part – exactly what you see
• Full page – scrolls and stitches the whole page into one image. Sticky headers appear only once. It even works in apps where only a panel scrolls, like web inboxes and dashboards.
• Screen or window – capture another app, a whole monitor or another tab
• Delay of 3, 5 or 10 seconds, for menus and hover states
• Right-click menu, toolbar button and keyboard shortcuts
• Open image – annotate any image you drop, paste or choose

ANNOTATE (17 tools)
• Pen and brush, highlighter (freehand or box)
• Line and arrow: classic or tapered, one or two heads, and curved by dragging the middle
• Rectangle and ellipse, with no fill, a light fill or a solid fill
• Text, callout bubbles, numbered steps that renumber themselves, and stamps (tick, cross, star, heart and more)
• Spotlight to dim everything except what matters, and a magnifier
• Blur, pixelate or black out emails, names and numbers before you share
• 10 colours plus any custom colour, size and opacity sliders, dashed and dotted lines, drop shadows
• Every annotation stays editable: move, resize, recolour, duplicate, reorder or delete it
• Undo and redo, crop, zoom, and keyboard shortcuts for every tool

SAVE AND SHARE
• PNG, JPG, or PDF (A4, Letter or one long page)
• Copy to the clipboard and paste into chat, email or docs
• Choose what happens after a capture: open the editor, save straight away or copy

PRIVATE BY DESIGN
• Everything happens on your computer. Nothing is uploaded.
• No account, no analytics, no tracking, no ads
• Only asks for access to a tab when you start a capture

Works in Chrome, Edge, Brave and other Chromium browsers.
```

**Graphic assets**

| Dashboard field | File |
| --- | --- |
| Store icon (128×128) | `icons/icon128.png` |
| Screenshots (1280×800, upload in this order) | `store/screenshots/1-annotate.png` to `5-save.png` |
| Small promo tile (440×280) | `store/promo-small-440x280.png` |
| Marquee promo tile (1400×560, optional) | `store/promo-marquee-1400x560.png` |

**Official URL:** none
**Homepage URL:** https://github.com/atahabilder1/capture-and-annotate
**Support URL:** https://github.com/atahabilder1/capture-and-annotate/issues

## Privacy practices tab

**Single purpose**

```
Capture screenshots of web pages, screens or windows, annotate them, and save or copy the result.
```

**Permission justifications**

| Permission | Justification |
| --- | --- |
| activeTab | Takes a screenshot of the current tab, only after the user clicks the toolbar button, uses the right-click menu or presses a shortcut. |
| scripting | Shows the area-selection overlay and scrolls the page during full-page captures. Runs only on the current tab, only when the user starts a capture. |
| contextMenus | Adds the capture options to the right-click menu. |
| storage | Saves the user's settings, such as the default file format and what happens after a capture. |
| clipboardWrite | Copies the finished image to the clipboard when the user chooses Copy. |

**Remote code:** No, I am not using remote code. All JavaScript is included in the package.

**Data usage:** tick none of the data types. The extension collects no user data.

Tick all three certifications:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**

```
https://github.com/atahabilder1/capture-and-annotate/blob/main/PRIVACY.md
```

## Distribution tab

- Visibility: Public
- Regions: All regions
- Pricing: Free

## Test instructions (optional)

```
No account or setup needed. Open any web page and click the toolbar icon, or press Ctrl+Shift+S, to capture. The editor opens in a new tab.
```
