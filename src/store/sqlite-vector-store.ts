import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";
import type {
  Chunk,
  DocumentRecord,
  Embedding,
  RetrievedChunk,
  SearchFilter,
} from "../types.js";
import type { VectorStore } from "./vector-store.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    source_path TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    embedding_model TEXT NOT NULL,
    chunk_size INTEGER NOT NULL,
    chunk_overlap INTEGER NOT NULL,
    ingested_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_document_id ON chunks(document_id);
`;

interface DocumentRow {
  id: string;
  source_path: string;
  page_count: number;
  chunk_count: number;
  embedding_model: string;
  chunk_size: number;
  chunk_overlap: number;
  ingested_at: string;
}

interface SearchRow {
  id: string;
  document_id: string;
  page_number: number;
  text: string;
  distance: number;
}

/**
 * Stores chunk text and metadata in regular tables and vectors in a sqlite-vec
 * `vec0` table. Both share the chunk rowid. The vector table is created on the
 * first write because its dimension depends on the embedding model.
 */
export class SqliteVectorStore implements VectorStore {
  private readonly database: DatabaseSync;

  /** Opens (or creates) the SQLite database and loads sqlite-vec. */
  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.database = new DatabaseSync(databasePath, { allowExtension: true });
    this.database.loadExtension(getLoadablePath());
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.database.exec(SCHEMA);
  }

  /** Persists a document and its chunks, replacing earlier versions. */
  async replaceDocument(
    document: DocumentRecord,
    chunks: readonly Chunk[],
  ): Promise<void> {
    this.transaction(() => {
      const previous = this.database
        .prepare("SELECT id FROM documents WHERE id = ? OR source_path = ?")
        .all(document.id, document.sourcePath) as { id: string }[];
      for (const { id } of previous) {
        this.deleteDocumentRows(id);
      }

      this.database
        .prepare(
          `INSERT INTO documents (id, source_path, page_count, chunk_count,
             embedding_model, chunk_size, chunk_overlap, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          document.id,
          document.sourcePath,
          document.pageCount,
          document.chunkCount,
          document.embeddingModel,
          document.chunkSize,
          document.chunkOverlap,
          document.ingestedAt,
        );

      const firstChunk = chunks[0];
      if (firstChunk === undefined) {
        return;
      }
      this.ensureVectorTable(firstChunk.embedding.length);

      const insertChunk = this.database.prepare(
        "INSERT INTO chunks (id, document_id, page_number, text) VALUES (?, ?, ?, ?)",
      );
      const insertVector = this.database.prepare(
        "INSERT INTO chunk_vectors (rowid, embedding, document_id) VALUES (?, ?, ?)",
      );
      for (const chunk of chunks) {
        const { lastInsertRowid } = insertChunk.run(
          chunk.id,
          chunk.documentId,
          chunk.pageNumber,
          chunk.text,
        );
        insertVector.run(
          BigInt(lastInsertRowid),
          toBlob(chunk.embedding),
          chunk.documentId,
        );
      }
    });
  }

  /** Returns one stored document by id. */
  async findDocument(documentId: string): Promise<DocumentRecord | undefined> {
    const row = this.database
      .prepare("SELECT * FROM documents WHERE id = ?")
      .get(documentId) as DocumentRow | undefined;
    return row && toDocumentRecord(row);
  }

  /** Lists stored documents, newest first. */
  async listDocuments(): Promise<DocumentRecord[]> {
    const rows = this.database
      .prepare("SELECT * FROM documents ORDER BY ingested_at DESC")
      .all() as unknown as DocumentRow[];
    return rows.map(toDocumentRecord);
  }

  /** Searches sqlite-vec for the closest stored chunks. */
  async search(
    embedding: Embedding,
    topK: number,
    filter: SearchFilter = {},
  ): Promise<RetrievedChunk[]> {
    const dimension = this.vectorDimension();
    if (dimension === undefined) {
      return [];
    }
    if (dimension !== embedding.length) {
      throw new Error(
        `Question embedding has ${embedding.length} dimensions but the store uses ${dimension}. Was the embedding model changed?`,
      );
    }

    const documentFilter = filter.documentId ? "AND document_id = ?" : "";
    const parameters = filter.documentId
      ? [toBlob(embedding), topK, filter.documentId]
      : [toBlob(embedding), topK];
    const rows = this.database
      .prepare(
        `WITH nearest AS (
           SELECT rowid, distance FROM chunk_vectors
           WHERE embedding MATCH ? AND k = ? ${documentFilter}
         )
         SELECT chunks.id, chunks.document_id, chunks.page_number, chunks.text,
                nearest.distance
         FROM nearest JOIN chunks ON chunks.rowid = nearest.rowid
         ORDER BY nearest.distance`,
      )
      .all(...parameters) as unknown as SearchRow[];

    return rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      pageNumber: row.page_number,
      text: row.text,
      score: 1 - row.distance,
    }));
  }

  /** Removes a document and its chunks from SQLite. */
  async deleteByDocumentId(documentId: string): Promise<void> {
    this.transaction(() => this.deleteDocumentRows(documentId));
  }

  /** Closes the SQLite connection and releases resources. */
  async close(): Promise<void> {
    if (this.database.isOpen) {
      this.database.close();
    }
  }

  private deleteDocumentRows(documentId: string): void {
    if (this.vectorDimension() !== undefined) {
      this.database
        .prepare(
          "DELETE FROM chunk_vectors WHERE rowid IN (SELECT rowid FROM chunks WHERE document_id = ?)",
        )
        .run(documentId);
    }
    this.database.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
  }

  private ensureVectorTable(dimension: number): void {
    const existing = this.vectorDimension();
    if (existing === undefined) {
      this.database.exec(
        `CREATE VIRTUAL TABLE chunk_vectors USING vec0(
           embedding float[${dimension}] distance_metric=cosine,
           document_id text
         )`,
      );
      this.database
        .prepare("INSERT INTO settings (key, value) VALUES ('dimension', ?)")
        .run(String(dimension));
    } else if (existing !== dimension) {
      throw new Error(
        `Embeddings have ${dimension} dimensions but the store uses ${existing}. Use a new PDF_OLLAMA_DATABASE_FILE when changing the embedding model.`,
      );
    }
  }

  private vectorDimension(): number | undefined {
    const row = this.database
      .prepare("SELECT value FROM settings WHERE key = 'dimension'")
      .get() as { value: string } | undefined;
    return row && Number(row.value);
  }

  private transaction(work: () => void): void {
    this.database.exec("BEGIN");
    try {
      work();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function toBlob(embedding: Embedding): Uint8Array {
  return new Uint8Array(Float32Array.from(embedding).buffer);
}

function toDocumentRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    sourcePath: row.source_path,
    pageCount: row.page_count,
    chunkCount: row.chunk_count,
    embeddingModel: row.embedding_model,
    chunkSize: row.chunk_size,
    chunkOverlap: row.chunk_overlap,
    ingestedAt: row.ingested_at,
  };
}
