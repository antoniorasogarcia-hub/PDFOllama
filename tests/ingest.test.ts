import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractPdfPages, splitPagesIntoChunks } from "../src/ingest/ingest.js";
import { createPdf } from "./fixtures/pdf-builder.js";
import { samplePages } from "./fixtures/sample-document.js";

describe("extractPdfPages", () => {
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), "pdf-ollama-ingest-"));
  });

  afterEach(async () => {
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("extracts text from each page and preserves page numbers", async () => {
    const pdfPath = await writePdf("two-pages.pdf", [
      "First page text",
      "Second page text",
    ]);

    await expect(extractPdfPages(pdfPath)).resolves.toEqual([
      { pageNumber: 1, text: "First page text" },
      { pageNumber: 2, text: "Second page text" },
    ]);
  });

  it("keeps Spanish characters, line breaks, and empty pages", async () => {
    const pdfPath = await writePdf("sample.pdf", samplePages);

    const pages = await extractPdfPages(pdfPath);

    expect(pages).toHaveLength(samplePages.length);
    expect(pages[0]?.text).toContain("Laboratorios Nébula S.L.");
    expect(pages[0]?.text).toContain("química Irene Valcárcel.\n");
    expect(pages[3]?.text).toContain("Hotel | 95 euros por noche");
    expect(pages[5]).toEqual({ pageNumber: 6, text: "" });
  });

  it("rejects files that are not PDFs", async () => {
    const filePath = join(testDirectory, "not-a-pdf.pdf");
    await writeFile(filePath, "This is not a PDF.");

    await expect(extractPdfPages(filePath)).rejects.toThrow(
      "Input file is not a PDF",
    );
  });

  it("rejects PDFs without extractable text", async () => {
    const pdfPath = await writePdf("empty.pdf", [""]);

    await expect(extractPdfPages(pdfPath)).rejects.toThrow(
      "PDF contains no extractable text",
    );
  });

  async function writePdf(
    fileName: string,
    pageTexts: readonly string[],
  ): Promise<string> {
    const pdfPath = join(testDirectory, fileName);
    await writeFile(pdfPath, createPdf(pageTexts));
    return pdfPath;
  }
});

describe("splitPagesIntoChunks", () => {
  const sentence = (index: number): string =>
    `Frase número ${index} del documento de prueba.`;
  const longPage = Array.from({ length: 40 }, (_, index) =>
    sentence(index),
  ).join(" ");

  it("keeps short pages as a single chunk with page metadata", () => {
    const chunks = splitPagesIntoChunks(
      [
        { pageNumber: 1, text: "Hola." },
        { pageNumber: 2, text: "" },
        { pageNumber: 3, text: "Adiós." },
      ],
      "doc",
      { size: 100, overlap: 10 },
    );

    expect(chunks).toEqual([
      { id: "doc:1:0", documentId: "doc", pageNumber: 1, text: "Hola." },
      { id: "doc:3:0", documentId: "doc", pageNumber: 3, text: "Adiós." },
    ]);
  });

  it("splits long pages into chunks within the size limit", () => {
    const chunks = splitPagesIntoChunks(
      [{ pageNumber: 7, text: longPage }],
      "doc",
      { size: 100, overlap: 20 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.pageNumber).toBe(7);
      expect(chunk.text.length).toBeLessThanOrEqual(400);
    }
    expect(chunks.map((chunk) => chunk.id)).toEqual(
      chunks.map((_, index) => `doc:7:${index}`),
    );
  });

  it("repeats trailing sentences of a chunk at the start of the next one", () => {
    const chunks = splitPagesIntoChunks(
      [{ pageNumber: 1, text: longPage }],
      "doc",
      { size: 100, overlap: 20 },
    );

    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1]?.text ?? "";
      const current = chunks[index]?.text ?? "";
      const firstSentence =
        current.match(/^Frase número \d+[^.]*\./u)?.[0] ?? "";
      const overlap = previous.slice(previous.indexOf(firstSentence));

      expect(previous).toContain(firstSentence);
      expect(current.startsWith(overlap)).toBe(true);
      expect(overlap.length).toBeLessThanOrEqual(80);
    }
  });

  it("does not drop or reorder text when removing the overlap", () => {
    const chunks = splitPagesIntoChunks(
      [{ pageNumber: 1, text: longPage }],
      "doc",
      { size: 100, overlap: 0 },
    );

    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(longPage);
  });

  it("splits sentences longer than the chunk size by words", () => {
    const longSentence = Array.from({ length: 200 }, () => "palabra").join(" ");
    const chunks = splitPagesIntoChunks(
      [{ pageNumber: 1, text: longSentence }],
      "doc",
      { size: 25, overlap: 5 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(100);
    }
  });
});
