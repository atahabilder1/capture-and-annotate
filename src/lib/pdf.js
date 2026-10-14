// Minimal PDF writer: one JPEG image per page, no dependencies.

const A4_WIDTH = 595.28; // points
const A4_HEIGHT = 841.89;

// Splits a (possibly very tall) canvas into A4-width pages and returns a PDF Blob.
export async function canvasToPdf(canvas, quality = 0.92) {
  const scale = A4_WIDTH / canvas.width;
  const sliceHeight = Math.floor(A4_HEIGHT / scale);
  const slices = [];
  if (canvas.height <= sliceHeight) {
    slices.push({ sy: 0, sh: canvas.height, pageHeight: canvas.height * scale });
  } else {
    for (let sy = 0; sy < canvas.height; sy += sliceHeight) {
      slices.push({ sy, sh: Math.min(sliceHeight, canvas.height - sy), pageHeight: A4_HEIGHT });
    }
  }

  const pages = [];
  const slice = document.createElement('canvas');
  const ctx = slice.getContext('2d');
  for (const { sy, sh, pageHeight } of slices) {
    slice.width = canvas.width;
    slice.height = sh;
    ctx.fillStyle = '#fff'; // JPEG has no transparency
    ctx.fillRect(0, 0, slice.width, sh);
    ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
    const blob = await new Promise((r) => slice.toBlob(r, 'image/jpeg', quality));
    pages.push({
      jpeg: new Uint8Array(await blob.arrayBuffer()),
      width: canvas.width,
      height: sh,
      pageWidth: A4_WIDTH,
      pageHeight,
      drawHeight: sh * scale,
    });
  }
  return new Blob([buildPdf(pages)], { type: 'application/pdf' });
}

// pages: [{ jpeg: Uint8Array, width, height (pixels), pageWidth, pageHeight, drawHeight (points) }]
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
    const content = `q ${n(p.pageWidth)} 0 0 ${n(p.drawHeight)} 0 ${n(p.pageHeight - p.drawHeight)} cm /Im0 Do Q`;
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
