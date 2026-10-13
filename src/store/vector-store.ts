import type {
  Chunk,
  DocumentRecord,
  Embedding,
  RetrievedChunk,
  SearchFilter,
} from "../types.js";

export interface VectorStore {
  /**
   * Atomically stores a document and its chunks, replacing any document with
   * the same id or the same source path so re-ingestion never duplicates data.
   */
  replaceDocument(
    document: DocumentRecord,
    chunks: readonly Chunk[],
  ): Promise<void>;
  /** Returns a stored document, or undefined when it does not exist. */
  findDocument(documentId: string): Promise<DocumentRecord | undefined>;
  /** Returns all stored documents, most recently ingested first. */
  listDocuments(): Promise<DocumentRecord[]>;
  /** Finds the closest stored chunks for an embedding. */
  search(
    embedding: Embedding,
    topK: number,
    filter?: SearchFilter,
  ): Promise<RetrievedChunk[]>;
  /** Removes all chunks belonging to one document. */
  deleteByDocumentId(documentId: string): Promise<void>;
  /** Releases storage resources. */
  close(): Promise<void>;
}
