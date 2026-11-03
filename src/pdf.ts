/**
 * Tiny single-page PDF writer (Helvetica, WinAnsi). Only the mock provider uses it, to give
 * `descargar_pdf` a real file to write. The legal PDF with the VERI*FACTU QR always comes
 * from the real provider.
 */

const WIN_ANSI_EXTRA: Record<string, number> = { '€': 0x80, '–': 0x96, '—': 0x97, '·': 0xb7 };

function encodeText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = WIN_ANSI_EXTRA[ch] ?? ch.codePointAt(0)!;
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (code >= 0x20 && code < 0x7f) out += ch;
    else if (code <= 0xff) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += '?';
  }
  return out;
}

export function renderTextPdf(lines: string[]): Uint8Array {
  const fontSize = 10;
  const leading = 14;
  const visible = lines.slice(0, 50);
  const content = [
    'BT',
    `/F1 ${fontSize} Tf`,
    `${leading} TL`,
    '50 800 Td',
    ...visible.map((line) => `(${encodeText(line)}) Tj T*`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
