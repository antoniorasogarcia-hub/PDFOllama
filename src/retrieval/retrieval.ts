import { basename } from "node:path";
import type { Embedder } from "../embeddings/embedder.js";
import type { VectorStore } from "../store/vector-store.js";
import type { RetrievedChunk, SearchFilter } from "../types.js";

/**
 * Fails when some stored document was embedded with a different model, because
 * its vectors are not comparable with the question's embedding.
 */
export async function assertEmbeddingModelMatches(
  store: VectorStore,
  embeddingModel: string,
): Promise<void> {
  const mismatched = (await store.listDocuments()).filter(
    (document) => document.embeddingModel !== embeddingModel,
  );
  if (mismatched.length > 0) {
    const names = mismatched
      .map((document) => basename(document.sourcePath))
      .join(", ");
    throw new Error(
      `${names} was indexed with a different embedding model than ${embeddingModel}. Ingest it again or restore PDF_OLLAMA_EMBEDDING_MODEL.`,
    );
  }
}

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
