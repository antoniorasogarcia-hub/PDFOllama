import type { Embedding } from "../types.js";

export interface Embedder {
  /** Creates a vector representation for one piece of text. */
  embed(text: string): Promise<Embedding>;
  /** Creates vector representations for multiple pieces of text. */
  embedMany(texts: readonly string[]): Promise<Embedding[]>;
}
