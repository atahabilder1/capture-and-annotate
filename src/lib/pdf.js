// Minimal PDF writer: one JPEG image per page, no dependencies.

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] }; // points
const MARGIN = 24; // points; keeps printers from clipping the edges
const MAX_PAGE = 14400; // largest page side most PDF readers accept

// Turns a canvas into a PDF Blob.
// pageSize 'a4' | 'letter': long images are split across pages, wide ones go landscape.
// pageSize 'fit': one page the size of the image (cssWidth = its width on screen, in CSS px).
export async function canvasToPdf(canvas, { pageSize = 'a4', quality = 0.92, cssWidth = canvas.width } = {}) {
  const slices = [];
  if (pageSize === 'fit') {
    let width = cssWidth * 0.75; // 96 CSS px per inch, 72 points per inch
    let height = (width * canvas.height) / canvas.width;
    const shrink = Math.min(1, MAX_PAGE / width, MAX_PAGE / height);
    width *= shrink;
    height *= shrink;
    slices.push({ sy: 0, sh: canvas.height, pageWidth: width, pageHeight: height, x: 0, y: 0, w: width, h: height });
  } else {
    let [pageWidth, pageHeight] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
    if (canvas.width > canvas.height) [pageWidth, pageHeight] = [pageHeight, pageWidth];
    const boxWidth = pageWidth - 2 * MARGIN;
    const boxHeight = pageHeight - 2 * MARGIN;
    // Scale to the page width, but never enlarge small captures past their on-screen size.
    const scale = Math.min(boxWidth / canvas.width, (cssWidth * 0.75) / canvas.width);
    const sliceHeight = Math.max(1, Math.floor(boxHeight / scale));
    const drawWidth = canvas.width * scale;
    for (let sy = 0; sy < canvas.height; sy += sliceHeight) {
      const sh = Math.min(sliceHeight, canvas.height - sy);
      slices.push({ sy, sh, pageWidth, pageHeight, x: (pageWidth - drawWidth) / 2, y: MARGIN, w: drawWidth, h: sh * scale });
    }
  }

  const pages = [];
  const slice = document.createElement('canvas');
  const ctx = slice.getContext('2d');
  for (const s of slices) {
    slice.width = canvas.width;
    slice.height = s.sh;
    ctx.fillStyle = '#fff'; // JPEG has no transparency
    ctx.fillRect(0, 0, slice.width, s.sh);
    ctx.drawImage(canvas, 0, s.sy, canvas.width, s.sh, 0, 0, canvas.width, s.sh);
    const blob = await new Promise((r) => slice.toBlob(r, 'image/jpeg', quality));
    pages.push({
      jpeg: new Uint8Array(await blob.arrayBuffer()),
      width: canvas.width,
      height: s.sh,
      pageWidth: s.pageWidth,
      pageHeight: s.pageHeight,
      // Image placement on the page, from the top-left corner.
      x: s.x,
      y: s.y,
      drawWidth: s.w,
      drawHeight: s.h,
    });
  }
  return new Blob([buildPdf(pages)], { type: 'application/pdf' });
}

// pages: [{ jpeg: Uint8Array, width, height (pixels), pageWidth, pageHeight, x, y, drawWidth, drawHeight (points) }]
// x/y are measured from the top-left of the page.
export function buildPdf(pages) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (num, ...parts) => {
    offsets[num] = length;
    push(`${num} 0 obj\n`);
    parts.forEach(push);
    push('\nendobj\n');
  };
  const n = (x) => (Math.round(x * 100) / 100).toString();

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // marks the file as binary

  const kids = pages.map((_, i) => `${3 + 3 * i} 0 R`).join(' ');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);

  pages.forEach((p, i) => {
    const num = 3 + 3 * i;
    object(
      num,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(p.pageWidth)} ${n(p.pageHeight)}] ` +
        `/Resources << /XObject << /Im0 ${num + 2} 0 R >> >> /Contents ${num + 1} 0 R >>`,
    );
    const content = `q ${n(p.drawWidth)} 0 0 ${n(p.drawHeight)} ${n(p.x)} ${n(p.pageHeight - p.y - p.drawHeight)} cm /Im0 Do Q`;
    object(num + 1, `<< /Length ${content.length} >>\nstream\n`, content, '\nendstream');
    object(
      num + 2,
      `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      p.jpeg,
      '\nendstream',
    );
  });

  const size = 3 + 3 * pages.length;
  const xref = length;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let i = 1; i < size; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
