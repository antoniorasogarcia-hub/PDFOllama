import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteVectorStore } from "../src/store/sqlite-vector-store.js";
import type { Chunk, DocumentRecord } from "../src/types.js";

describe("SqliteVectorStore", () => {
  let store: SqliteVectorStore;

  beforeEach(() => {
    store = new SqliteVectorStore(":memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  it("returns the closest chunks first with a cosine similarity score", async () => {
    await store.replaceDocument(createDocument("a"), [
      createChunk("a", 1, [1, 0, 0]),
      createChunk("a", 2, [0, 1, 0]),
      createChunk("a", 3, [0.7, 0.7, 0]),
    ]);

    const results = await store.search([1, 0.1, 0], 2);

    expect(results.map((result) => result.pageNumber)).toEqual([1, 3]);
    expect(results[0]?.score).toBeCloseTo(0.995, 2);
    expect(results[0]).toMatchObject({
      id: "a:1:0",
      documentId: "a",
      text: "Text of a page 1",
    });
  });

  it("filters results by document", async () => {
    await store.replaceDocument(createDocument("a"), [
      createChunk("a", 1, [1, 0]),
    ]);
    await store.replaceDocument(createDocument("b"), [
      createChunk("b", 1, [0.9, 0.1]),
    ]);

    const results = await store.search([1, 0], 5, { documentId: "b" });

    expect(results.map((result) => result.documentId)).toEqual(["b"]);
  });

  it("replaces a document with the same id instead of duplicating it", async () => {
    await store.replaceDocument(createDocument("a"), [
      createChunk("a", 1, [1, 0]),
    ]);
    await store.replaceDocument(createDocument("a"), [
      createChunk("a", 2, [1, 0]),
    ]);

    const results = await store.search([1, 0], 10);

    expect(results.map((result) => result.pageNumber)).toEqual([2]);
    expect(await store.listDocuments()).toHaveLength(1);
  });

  it("replaces an earlier version of a file at the same source path", async () => {
    await store.replaceDocument(createDocument("old", "/docs/manual.pdf"), [
      createChunk("old", 1, [1, 0]),
    ]);
    await store.replaceDocument(createDocument("new", "/docs/manual.pdf"), [
      createChunk("new", 1, [1, 0]),
    ]);

    expect(
      (await store.listDocuments()).map((document) => document.id),
    ).toEqual(["new"]);
    expect(
      (await store.search([1, 0], 10)).map((result) => result.documentId),
    ).toEqual(["new"]);
  });

  it("finds and deletes documents with their chunks", async () => {
    const document = createDocument("a");
    await store.replaceDocument(document, [createChunk("a", 1, [1, 0])]);

    await expect(store.findDocument("a")).resolves.toEqual(document);
    await store.deleteByDocumentId("a");

    await expect(store.findDocument("a")).resolves.toBeUndefined();
    await expect(store.search([1, 0], 10)).resolves.toEqual([]);
  });

  it("returns no results for an empty store", async () => {
    await expect(store.search([1, 0], 3)).resolves.toEqual([]);
  });

  it("rejects embeddings with a different dimension", async () => {
    await store.replaceDocument(createDocument("a"), [
      createChunk("a", 1, [1, 0]),
    ]);

    await expect(
      store.replaceDocument(createDocument("b"), [
        createChunk("b", 1, [1, 0, 0]),
      ]),
    ).rejects.toThrow("Embeddings have 3 dimensions but the store uses 2");
    await expect(store.search([1, 0, 0], 3)).rejects.toThrow(
      "Question embedding has 3 dimensions",
    );
    await expect(store.findDocument("b")).resolves.toBeUndefined();
  });
});

function createDocument(
  id: string,
  sourcePath = `/docs/${id}.pdf`,
): DocumentRecord {
  return {
    id,
    sourcePath,
    pageCount: 3,
    chunkCount: 1,
    embeddingModel: "test-model",
    chunkSize: 450,
    chunkOverlap: 75,
    ingestedAt: `2026-01-01T00:00:0${id.length}.000Z`,
  };
}

function createChunk(
  documentId: string,
  pageNumber: number,
  embedding: number[],
): Chunk {
  return {
    id: `${documentId}:${pageNumber}:0`,
    documentId,
    pageNumber,
    text: `Text of ${documentId} page ${pageNumber}`,
    embedding,
  };
}
