import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Embedder } from "../src/embeddings/embedder.js";
import { indexPdf, indexPdfData } from "../src/ingest/index-document.js";
import { SqliteVectorStore } from "../src/store/sqlite-vector-store.js";
import { createPdf } from "./fixtures/pdf-builder.js";
import { samplePages } from "./fixtures/sample-document.js";

const config = {
  chunking: { size: 120, overlap: 20 },
  embedding: { batchSize: 4 },
  models: { embedding: "fake-embedder", chat: "fake-chat" },
};

describe("indexPdf", () => {
  let testDirectory: string;
  let store: SqliteVectorStore;
  let embedder: Embedder & { embedMany: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), "pdf-ollama-index-"));
    store = new SqliteVectorStore(":memory:");
    embedder = {
      embed: vi.fn(async () => [1, 0]),
      embedMany: vi.fn(async (texts: readonly string[]) =>
        texts.map(() => [1, 0]),
      ),
    };
  });

  afterEach(async () => {
    await store.close();
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("stores every chunk with its page and reports pages without text", async () => {
    const pdfPath = await writePdf("manual.pdf", samplePages);
    const progress: number[] = [];

    const result = await indexPdf(pdfPath, {
      embedder,
      store,
      config,
      onProgress: (done) => progress.push(done),
    });

    expect(result.status).toBe("indexed");
    expect(result.pagesWithoutText).toEqual([6]);
    expect(result.document).toMatchObject({
      sourcePath: pdfPath,
      pageCount: 7,
      embeddingModel: "fake-embedder",
    });
    expect(result.document.id).toMatch(/^[0-9a-f]{64}$/u);

    const stored = await store.search([1, 0], 100);
    expect(stored).toHaveLength(result.document.chunkCount);
    expect(new Set(stored.map((chunk) => chunk.pageNumber))).toEqual(
      new Set([1, 2, 3, 4, 5, 7]),
    );
    expect(progress.at(-1)).toBe(result.document.chunkCount);
    expect(
      embedder.embedMany.mock.calls.every(([texts]) => texts.length <= 4),
    ).toBe(true);
  });

  it("skips a PDF that was already indexed with the same settings", async () => {
    const pdfPath = await writePdf("manual.pdf", samplePages);
    await indexPdf(pdfPath, { embedder, store, config });
    embedder.embedMany.mockClear();

    const result = await indexPdf(pdfPath, { embedder, store, config });

    expect(result.status).toBe("unchanged");
    expect(embedder.embedMany).not.toHaveBeenCalled();
  });

  it("re-indexes when the chunking settings change, without duplicates", async () => {
    const pdfPath = await writePdf("manual.pdf", samplePages);
    await indexPdf(pdfPath, { embedder, store, config });

    const result = await indexPdf(pdfPath, {
      embedder,
      store,
      config: { ...config, chunking: { size: 300, overlap: 30 } },
    });

    expect(result.status).toBe("indexed");
    expect(await store.listDocuments()).toHaveLength(1);
    expect(await store.search([1, 0], 100)).toHaveLength(
      result.document.chunkCount,
    );
  });

  it("replaces the previous version when a PDF changes at the same path", async () => {
    const pdfPath = await writePdf("manual.pdf", ["Primera versión."]);
    await indexPdf(pdfPath, { embedder, store, config });
    await writePdf("manual.pdf", ["Segunda versión."]);

    await indexPdf(pdfPath, { embedder, store, config });

    const chunks = await store.search([1, 0], 10);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["Segunda versión."]);
    expect(await store.listDocuments()).toHaveLength(1);
  });

  it("indexes PDF bytes from memory under the given source path", async () => {
    const result = await indexPdfData(
      createPdf(samplePages),
      "upload/manual.pdf",
      {
        embedder,
        store,
        config,
      },
    );

    expect(result.status).toBe("indexed");
    expect(result.document.sourcePath).toBe("upload/manual.pdf");
    expect(await store.findDocument(result.document.id)).toBeDefined();
  });

  it("rejects bytes that are not a PDF before embedding anything", async () => {
    await expect(
      indexPdfData(Buffer.from("hola"), "upload/x.pdf", {
        embedder,
        store,
        config,
      }),
    ).rejects.toThrow("Input file is not a PDF");
    expect(embedder.embedMany).not.toHaveBeenCalled();
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
