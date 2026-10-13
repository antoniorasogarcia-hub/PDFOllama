export type Embedding = readonly number[];

export interface PdfPage {
  pageNumber: number;
  text: string;
}

export interface TextChunk {
  id: string;
  documentId: string;
  pageNumber: number;
  text: string;
}

export interface Chunk extends TextChunk {
  embedding: Embedding;
}

export interface RetrievedChunk extends TextChunk {
  /** Cosine similarity between the question and the chunk, from -1 to 1. */
  score: number;
}

/** An ingested PDF. The id is the SHA-256 of the file contents. */
export interface DocumentRecord {
  id: string;
  sourcePath: string;
  pageCount: number;
  chunkCount: number;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  ingestedAt: string;
}

export interface SearchFilter {
  documentId?: string;
}

export interface Citation {
  documentId: string;
  pageNumber: number;
}

export interface Answer {
  text: string;
  citations: Citation[];
}

export type AnswerStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "citations"; citations: Citation[] };
