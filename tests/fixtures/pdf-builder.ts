const LINE_WIDTH = 90;
const FONT_SIZE = 11;
const LEADING = 14;

/**
 * Builds a minimal PDF with one entry per page. Text is wrapped into lines,
 * blank lines separate paragraphs, and Latin-1 characters (á, ñ, ¿, €) are
 * encoded with WinAnsiEncoding so pdf.js extracts them correctly.
 */
export function createPdf(pageTexts: readonly string[]): Buffer {
  const firstPageObject = 3;
  const fontObject = firstPageObject + pageTexts.length * 2;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageTexts
      .map((_, index) => `${firstPageObject + index * 2} 0 R`)
      .join(" ")}] /Count ${pageTexts.length} >>`,
  ];

  for (const [index, pageText] of pageTexts.entries()) {
    const pageObject = firstPageObject + index * 2;
    const contentObject = pageObject + 1;
    const stream = createTextStream(pageText);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream.toString("latin1")}\nendstream`,
    );
  }
  objects.push(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, "latin1");
}

function createTextStream(pageText: string): Buffer {
  const lines = wrapLines(pageText);
  if (lines.length === 0) {
    return Buffer.alloc(0);
  }

  const operations = lines.map((line) => `(${encodeText(line)}) Tj T*`);
  return Buffer.from(
    `BT /F1 ${FONT_SIZE} Tf ${LEADING} TL 50 790 Td ${operations.join(" ")} ET`,
    "latin1",
  );
}

function wrapLines(pageText: string): string[] {
  const lines: string[] = [];
  for (const paragraph of pageText.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      if (line && line.length + 1 + word.length > LINE_WIDTH) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    lines.push(line);
  }
  while (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function encodeText(text: string): string {
  return [...text]
    .map((character) => {
      if (character === "€") {
        return "\\200";
      }
      const code = character.charCodeAt(0);
      if (code > 0xff) {
        throw new Error(`Character "${character}" is not supported.`);
      }
      if (character === "(" || character === ")" || character === "\\") {
        return `\\${character}`;
      }
      return code > 0x7e ? `\\${code.toString(8).padStart(3, "0")}` : character;
    })
    .join("");
}
