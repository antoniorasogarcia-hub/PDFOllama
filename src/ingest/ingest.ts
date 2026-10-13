import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { AppConfig } from "../config.js";
import type { PdfPage, TextChunk } from "../types.js";

/** Rough token estimate; keeps chunks well below the embedding context limit. */
const CHARS_PER_TOKEN = 4;

const standardFontDataUrl = join(
  dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")),
  "standard_fonts/",
);

/** Reads a PDF file and checks its header before parsing it. */
export async function readPdfFile(pdfPath: string): Promise<Buffer> {
  const file = await readFile(pdfPath);
  assertPdfHeader(file);
  return file;
}

/** Fails when the bytes do not start with the PDF signature. */
export function assertPdfHeader(data: Uint8Array): void {
  if (!Buffer.from(data.subarray(0, 5)).equals(Buffer.from("%PDF-"))) {
    throw new Error("Input file is not a PDF (missing %PDF- header).");
  }
}

/** Extracts text from a PDF while preserving page numbers. */
export async function extractPdfPages(pdfPath: string): Promise<PdfPage[]> {
  return extractPdfPagesFromData(await readPdfFile(pdfPath));
}

/** Extracts text from PDF bytes; pages without text are kept with empty text. */
export async function extractPdfPagesFromData(
  data: Uint8Array,
): Promise<PdfPage[]> {
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    standardFontDataUrl,
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const pdf = await loadingTask.promise;
    const pages: PdfPage[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const rawText = content.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
        )
        .join("");

      pages.push({ pageNumber, text: normalizePageText(rawText) });
      page.cleanup();
    }

    if (!pages.some((page) => page.text.length > 0)) {
      throw new Error(
        "PDF contains no extractable text; it may be empty or scanned.",
      );
    }

    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

function normalizePageText(text: string): string {
  return text
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ ?\n ?/gu, "\n")
    .trim();
}

/** Splits extracted pages into text chunks with source metadata. */
export function splitPagesIntoChunks(
  pages: readonly PdfPage[],
  documentId: string,
  config: AppConfig["chunking"],
): TextChunk[] {
  const maxChars = config.size * CHARS_PER_TOKEN;
  const overlapChars = config.overlap * CHARS_PER_TOKEN;

  return pages.flatMap((page) =>
    packSegments(
      splitIntoSegments(page.text, maxChars),
      maxChars,
      overlapChars,
    ).map((text, index) => ({
      id: `${documentId}:${page.pageNumber}:${index}`,
      documentId,
      pageNumber: page.pageNumber,
      text,
    })),
  );
}

/** Splits text into sentences, falling back to word groups for long sentences. */
function splitIntoSegments(text: string, maxChars: number): string[] {
  return text
    .split(/(?<=[.!?…:;])\s+|\n+/u)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .flatMap((segment) =>
      segment.length <= maxChars
        ? [segment]
        : splitLongSegment(segment, maxChars),
    );
}

function splitLongSegment(segment: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const word of segment.split(" ")) {
    for (let start = 0; start < word.length; start += maxChars) {
      const part = word.slice(start, start + maxChars);
      if (current && current.length + 1 + part.length > maxChars) {
        pieces.push(current);
        current = part;
      } else {
        current = current ? `${current} ${part}` : part;
      }
    }
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}

/**
 * Greedily packs segments into chunks of at most maxChars. Each new chunk
 * starts with the trailing segments of the previous one, up to overlapChars.
 */
function packSegments(
  segments: readonly string[],
  maxChars: number,
  overlapChars: number,
): string[] {
  const chunks: string[] = [];
  let current: string[] = [];

  for (const segment of segments) {
    if (current.length > 0 && joinedLength([...current, segment]) > maxChars) {
      chunks.push(current.join(" "));
      const roomForOverlap = Math.min(
        overlapChars,
        maxChars - segment.length - 1,
      );
      current = trailingSegments(current, roomForOverlap);
    }
    current.push(segment);
  }

  if (current.length > 0) {
    chunks.push(current.join(" "));
  }
  return chunks;
}

function trailingSegments(
  segments: readonly string[],
  maxChars: number,
): string[] {
  const tail: string[] = [];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index] as string;
    if (joinedLength([segment, ...tail]) > maxChars) {
      break;
    }
    tail.unshift(segment);
  }
  return tail;
}

function joinedLength(segments: readonly string[]): number {
  return (
    segments.reduce((total, segment) => total + segment.length, 0) +
    Math.max(segments.length - 1, 0)
  );
}
