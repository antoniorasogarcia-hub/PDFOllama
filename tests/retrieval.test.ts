import { describe, expect, it, vi } from "vitest";
import type { Embedder } from "../src/embeddings/embedder.js";
import { retrieveRelevantChunks } from "../src/retrieval/retrieval.js";
import type { VectorStore } from "../src/store/vector-store.js";
import type { RetrievedChunk } from "../src/types.js";

describe("retrieveRelevantChunks", () => {
  const chunk: RetrievedChunk = {
    id: "doc:2:0",
    documentId: "doc",
    pageNumber: 2,
    text: "24 días laborables de vacaciones",
    score: 0.8,
  };

  it("embeds the question and searches the store with topK and filter", async () => {
    const embedder: Embedder = {
      embed: vi.fn(async () => [0.5, 0.5]),
      embedMany: vi.fn(),
    };
    const search = vi.fn(async () => [chunk]);
    const store = { search } as unknown as VectorStore;

    const results = await retrieveRelevantChunks(
      "  ¿Cuántos días de vacaciones hay?  ",
      embedder,
      store,
      3,
      { documentId: "doc" },
    );

    expect(results).toEqual([chunk]);
    expect(embedder.embed).toHaveBeenCalledWith(
      "¿Cuántos días de vacaciones hay?",
    );
    expect(search).toHaveBeenCalledWith([0.5, 0.5], 3, { documentId: "doc" });
  });

  it("rejects an empty question without calling the embedder", async () => {
    const embedder: Embedder = { embed: vi.fn(), embedMany: vi.fn() };

    await expect(
      retrieveRelevantChunks("   ", embedder, {} as VectorStore, 3),
    ).rejects.toThrow("The question is empty.");
    expect(embedder.embed).not.toHaveBeenCalled();
  });
});
