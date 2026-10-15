// Builds browser-specific copies of the extension and their store zips:
//   dist/chrome/   dist/capture-and-annotate-chrome-<version>.zip   (Chrome, Edge, Brave, Opera)
//   dist/firefox/  dist/capture-and-annotate-firefox-<version>.zip  (Firefox)
// Run: node scripts/build.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const FILES = ['src', 'icons', 'fonts'];

const targets = {
  chrome: (m) => m,
  firefox: (m) => {
    // Firefox runs MV3 backgrounds as event pages rather than service workers.
    m.background = { scripts: ['src/background.js'], type: 'module' };
    // Firefox allows at most 45 characters here.
    m.name = 'Capture and Annotate – Screenshots & PDF';
    delete m.minimum_chrome_version;
    m.browser_specific_settings = {
      gecko: {
        id: 'capture-and-annotate@atahabilder1.github.io',
        // data_collection_permissions needs Firefox 140 (142 on Android).
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    };
    return m;
  },
};

rmSync(dist, { recursive: true, force: true });
for (const [name, transform] of Object.entries(targets)) {
  const out = join(dist, name);
  mkdirSync(out, { recursive: true });
  for (const f of FILES) cpSync(join(root, f), join(out, f), { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(transform(structuredClone(manifest)), null, 2) + '\n');
  const zip = join(dist, `capture-and-annotate-${name}-${manifest.version}.zip`);
  execFileSync('zip', ['-qr', zip, '.', '-x', '*.DS_Store'], { cwd: out });
  console.log(`Built ${name}: ${zip}`);
}
