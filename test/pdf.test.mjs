// Builds PDFs from real JPEGs and checks them with qpdf.
// Run: node test/pdf.test.mjs  (needs ImageMagick `convert` and `qpdf`)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPdf } from '../src/lib/pdf.js';

const dir = mkdtempSync(join(tmpdir(), 'capture-and-annotate-'));
const jpeg = (w, h, color) => {
  const file = join(dir, `${w}x${h}-${color}.jpg`);
  execFileSync('convert', ['-size', `${w}x${h}`, `xc:${color}`, file]);
  return new Uint8Array(readFileSync(file));
};

const cases = {
  single: [{ jpeg: jpeg(400, 300, 'red'), width: 400, height: 300, pageWidth: 595.28, pageHeight: 446.46, drawHeight: 446.46 }],
  multi: [
    { jpeg: jpeg(800, 1131, 'blue'), width: 800, height: 1131, pageWidth: 595.28, pageHeight: 841.89, drawHeight: 841.58 },
    { jpeg: jpeg(800, 400, 'green'), width: 800, height: 400, pageWidth: 595.28, pageHeight: 841.89, drawHeight: 297.64 },
  ],
};

let failed = false;
for (const [name, pages] of Object.entries(cases)) {
  const file = join(dir, `${name}.pdf`);
  writeFileSync(file, buildPdf(pages));
  try {
    execFileSync('qpdf', ['--check', file], { stdio: 'pipe' });
    const count = execFileSync('qpdf', ['--show-npages', file]).toString().trim();
    if (Number(count) !== pages.length) throw new Error(`expected ${pages.length} pages, got ${count}`);
    console.log(`ok   ${name}: ${count} page(s)`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${name}: ${err.stdout || err.message}`);
  }
}
process.exit(failed ? 1 : 0);
