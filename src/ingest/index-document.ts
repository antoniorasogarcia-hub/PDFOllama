import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { AppConfig } from "../config.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { VectorStore } from "../store/vector-store.js";
import type { Chunk, DocumentRecord, TextChunk } from "../types.js";
import {
  assertPdfHeader,
  extractPdfPagesFromData,
  readPdfFile,
  splitPagesIntoChunks,
} from "./ingest.js";

export interface IndexingDependencies {
  embedder: Embedder;
  store: VectorStore;
  config: Pick<AppConfig, "chunking" | "embedding" | "models">;
  /** Called after each embedding batch with the number of chunks done. */
  onProgress?: (embeddedChunks: number, totalChunks: number) => void;
}

export interface IndexingResult {
  status: "indexed" | "unchanged";
  document: DocumentRecord;
  /** Pages without extractable text, likely scanned images. */
  pagesWithoutText: number[];
}

/**
 * Extracts, chunks, embeds, and stores a PDF. A file whose contents were
 * already indexed with the same settings is skipped, and a changed file at
 * the same path replaces its previous version.
 */
export async function indexPdf(
  pdfPath: string,
  dependencies: IndexingDependencies,
): Promise<IndexingResult> {
  return indexPdfData(
    await readPdfFile(pdfPath),
    resolve(pdfPath),
    dependencies,
  );
}

/**
 * Indexes PDF bytes that are already in memory, such as an upload. The source
 * path identifies the document for replacement and display.
 */
export async function indexPdfData(
  file: Uint8Array,
  sourcePath: string,
  dependencies: IndexingDependencies,
): Promise<IndexingResult> {
  assertPdfHeader(file);
  const { store, config } = dependencies;
  const documentId = createHash("sha256").update(file).digest("hex");

  const existing = await store.findDocument(documentId);
  if (existing && hasSameSettings(existing, config)) {
    return { status: "unchanged", document: existing, pagesWithoutText: [] };
  }

  const pages = await extractPdfPagesFromData(file);
  const chunks = splitPagesIntoChunks(pages, documentId, config.chunking);
  const embeddedChunks = await embedChunks(chunks, dependencies);

  const document: DocumentRecord = {
    id: documentId,
    sourcePath,
    pageCount: pages.length,
    chunkCount: chunks.length,
    embeddingModel: config.models.embedding,
    chunkSize: config.chunking.size,
    chunkOverlap: config.chunking.overlap,
    ingestedAt: new Date().toISOString(),
  };
  await store.replaceDocument(document, embeddedChunks);

  return {
    status: "indexed",
    document,
    pagesWithoutText: pages
      .filter((page) => page.text.length === 0)
      .map((page) => page.pageNumber),
  };
}

async function embedChunks(
  chunks: readonly TextChunk[],
  { embedder, config, onProgress }: IndexingDependencies,
): Promise<Chunk[]> {
  const embedded: Chunk[] = [];
  for (
    let start = 0;
    start < chunks.length;
    start += config.embedding.batchSize
  ) {
    const batch = chunks.slice(start, start + config.embedding.batchSize);
    const embeddings = await embedder.embedMany(
      batch.map((chunk) => chunk.text),
    );
    for (const [index, chunk] of batch.entries()) {
      embedded.push({ ...chunk, embedding: embeddings[index] ?? [] });
    }
    onProgress?.(embedded.length, chunks.length);
  }
  return embedded;
}

function hasSameSettings(
  document: DocumentRecord,
  config: IndexingDependencies["config"],
): boolean {
  return (
    document.embeddingModel === config.models.embedding &&
    document.chunkSize === config.chunking.size &&
    document.chunkOverlap === config.chunking.overlap
  );
}
