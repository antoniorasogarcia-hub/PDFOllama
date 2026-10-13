import type { Embedder } from "../embeddings/embedder.js";
import type { VectorStore } from "../store/vector-store.js";
import type { RetrievedChunk, SearchFilter } from "../types.js";

/** Embeds a question and returns its most relevant stored chunks. */
export async function retrieveRelevantChunks(
  question: string,
  embedder: Embedder,
  store: VectorStore,
  topK: number,
  filter: SearchFilter = {},
): Promise<RetrievedChunk[]> {
  const normalizedQuestion = question.trim();
  if (normalizedQuestion === "") {
    throw new Error("The question is empty.");
  }

  const embedding = await embedder.embed(normalizedQuestion);
  return store.search(embedding, topK, filter);
}
