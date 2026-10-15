# Store assets

Artwork and text for the Chrome Web Store listing.

```
store/
├── LISTING.md                    Every listing field, ready to paste into the Developer Dashboard
├── screenshots/                  1280×800, uploaded in this order
│   ├── 1-annotate.png
│   ├── 2-tools.png
│   ├── 3-privacy.png
│   ├── 4-full-page.png
│   └── 5-save.png
├── promo-small-440x280.png       Small promo tile (required)
├── promo-marquee-1400x560.png    Marquee promo tile (optional)
└── templates/
    ├── frames.html               Layout of every image above
    ├── demo-dashboard.html       Made-up page that is annotated in the screenshots
    ├── demo-article.html         Made-up long page for the full-page screenshot
    └── shots/                    Real screenshots of the extension used by frames.html
```

The store icon is `icons/icon128.png`.

## Updating the artwork

1. Serve the repository root, for example `python3 -m http.server 8000`.
2. If the interface changed, retake the images in `templates/shots/`:
   - `ed-*.png`: the editor at 1440×1110 with a device scale factor of 2, with `demo-dashboard.html` (captured at 1280×800, scale 2) opened and annotated
   - `popup.png` and `options.png`: the popup and settings pages at scale 2
   - `article-full.png`: a full-page screenshot of `demo-article.html` at 1000 px wide
3. Open `templates/frames.html` and screenshot each `<section>` at a device scale factor of 1. Each section is already the exact size the store needs.

Everything shown is made up: the "Atlas" dashboard, its people and its `example.com` addresses.
