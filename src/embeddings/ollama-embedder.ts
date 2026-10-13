import type { AppConfig } from "../config.js";
import {
  createInactivityTimeout,
  isRecord,
  OllamaError,
  postToOllama,
  toOllamaError,
} from "../ollama/ollama-http.js";
import type { Embedding } from "../types.js";
import type { Embedder } from "./embedder.js";

export class OllamaEmbedder implements Embedder {
  /** Stores the settings for the Ollama embedding adapter. */
  constructor(
    private readonly config: AppConfig["ollama"] & { model: string },
  ) {}

  /** Creates a vector using the configured Ollama embedding model. */
  async embed(text: string): Promise<Embedding> {
    const [embedding] = await this.embedMany([text]);
    if (embedding === undefined) {
      throw new OllamaError("Ollama returned no embedding.");
    }
    return embedding;
  }

  /** Creates vectors for multiple inputs using the configured Ollama model. */
  async embedMany(texts: readonly string[]): Promise<Embedding[]> {
    if (texts.length === 0) {
      return [];
    }

    const timeout = createInactivityTimeout(this.config.timeoutMs);
    try {
      const response = await postToOllama(
        this.config,
        "/api/embed",
        { model: this.config.model, input: texts },
        timeout.signal,
      );
      return parseEmbeddings(await response.json(), texts.length);
    } catch (error) {
      throw toOllamaError(error, this.config);
    } finally {
      timeout.clear();
    }
  }
}

function parseEmbeddings(body: unknown, expectedCount: number): Embedding[] {
  const embeddings = isRecord(body) ? body.embeddings : undefined;
  if (
    !Array.isArray(embeddings) ||
    embeddings.length !== expectedCount ||
    !embeddings.every(
      (embedding) =>
        Array.isArray(embedding) &&
        embedding.length > 0 &&
        embedding.every((value) => typeof value === "number"),
    )
  ) {
    throw new OllamaError(
      `Unexpected embedding response from Ollama: expected ${expectedCount} vectors.`,
    );
  }
  return embeddings as Embedding[];
}
