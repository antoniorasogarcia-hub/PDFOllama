import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import { generateAnswer } from "../generation/answer-generator.js";
import { indexPdfData } from "../ingest/index-document.js";
import {
  assertEmbeddingModelMatches,
  retrieveRelevantChunks,
} from "../retrieval/retrieval.js";
import { summarizeDocument } from "../summary/document-summary.js";
import type { DocumentRecord } from "../types.js";
import {
  HttpError,
  readBody,
  requireContentType,
  sendJson,
  startEventStream,
} from "./http-io.js";
import type { ServerContext } from "./server.js";

const MAX_QUESTION_LENGTH = 2000;
const MAX_JSON_BYTES = 64 * 1024;

/** A document as exposed by the API. */
export interface DocumentSummary {
  id: string;
  fileName: string;
  pageCount: number;
  chunkCount: number;
  ingestedAt: string;
}

/** GET /api/documents */
export async function listDocuments(
  _request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
): Promise<void> {
  const documents = await context.store.listDocuments();
  sendJson(response, 200, documents.map(toSummary));
}

/**
 * POST /api/documents?name=<file name> with the raw PDF as the body. Streams
 * progress events and ends with a "done" or "error" event.
 */
export async function uploadDocument(
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
  url: URL,
): Promise<void> {
  requireContentType(request, "application/pdf");
  const fileName = sanitizeFileName(url.searchParams.get("name") ?? "");
  const data = await readBody(request, context.config.server.maxUploadBytes);

  const send = startEventStream(response);
  try {
    send({ type: "started", fileName });
    const result = await indexPdfData(data, `upload/${fileName}`, {
      ...context,
      onProgress: (done, total) => send({ type: "progress", done, total }),
    });
    send({
      type: "done",
      status: result.status,
      document: toSummary(result.document),
      pagesWithoutText: result.pagesWithoutText,
    });
  } catch (error) {
    send({ type: "error", message: errorMessage(error) });
  }
  response.end();
}

/** DELETE /api/documents/:id */
export async function deleteDocument(
  response: ServerResponse,
  context: ServerContext,
  documentId: string,
): Promise<void> {
  await findDocumentOrFail(documentId, context);
  await context.store.deleteByDocumentId(documentId);
  response.writeHead(204).end();
}

/**
 * POST /api/ask with JSON { question, documentId? }. Streams "text_delta"
 * events, then one "citations" event, or an "error" event.
 */
export async function ask(
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
): Promise<void> {
  requireContentType(request, "application/json");
  const { question, documentId } = parseAskRequest(
    await readBody(request, MAX_JSON_BYTES),
  );
  if (documentId !== undefined) {
    await findDocumentOrFail(documentId, context);
  }

  const send = startEventStream(response);
  try {
    await assertEmbeddingModelMatches(
      context.store,
      context.config.models.embedding,
    );
    const chunks = await retrieveRelevantChunks(
      question,
      context.embedder,
      context.store,
      context.config.retrieval.topK,
      documentId === undefined ? {} : { documentId },
    );
    const names = await documentNames(context);

    for await (const event of generateAnswer(
      question,
      chunks,
      context.chatModel,
    )) {
      if (response.destroyed) {
        break;
      }
      if (event.type === "text_delta") {
        send(event);
      } else {
        send({
          type: "citations",
          citations: event.citations.map((citation) => ({
            ...citation,
            fileName: names.get(citation.documentId) ?? "",
          })),
        });
      }
    }
  } catch (error) {
    send({ type: "error", message: errorMessage(error) });
  }
  response.end();
}

/**
 * POST /api/documents/:id/summary with JSON { refresh? }. Streams "progress"
 * and "text_delta" events and ends with "done" (cached or not) or "error".
 */
export async function summarize(
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
  documentId: string,
): Promise<void> {
  requireContentType(request, "application/json");
  const refresh = parseSummaryRequest(await readBody(request, MAX_JSON_BYTES));
  await findDocumentOrFail(documentId, context);

  const send = startEventStream(response);
  try {
    for await (const event of summarizeDocument(documentId, context, {
      refresh,
    })) {
      if (response.destroyed) {
        break;
      }
      send(event);
    }
  } catch (error) {
    send({ type: "error", message: errorMessage(error) });
  }
  response.end();
}

/** Keeps a safe, readable file name ending in .pdf. */
export function sanitizeFileName(name: string): string {
  const cleaned = basename(name.replaceAll("\\", "/"))
    .replace(/[^\p{L}\p{N}._ ()-]/gu, "_")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 200);
  if (cleaned === "") {
    return "document.pdf";
  }
  return /\.pdf$/iu.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}

function parseAskRequest(body: Buffer): {
  question: string;
  documentId?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }

  const { question, documentId } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof question !== "string" || question.trim() === "") {
    throw new HttpError(400, "The question is empty.");
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new HttpError(
      400,
      `The question is longer than ${MAX_QUESTION_LENGTH} characters.`,
    );
  }
  if (documentId !== undefined && typeof documentId !== "string") {
    throw new HttpError(400, "documentId must be a string.");
  }
  return documentId === undefined ? { question } : { question, documentId };
}

function parseSummaryRequest(body: Buffer): boolean {
  if (body.length === 0) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
  const { refresh } = (parsed ?? {}) as Record<string, unknown>;
  if (refresh !== undefined && typeof refresh !== "boolean") {
    throw new HttpError(400, "refresh must be a boolean.");
  }
  return refresh === true;
}

async function findDocumentOrFail(
  documentId: string,
  context: ServerContext,
): Promise<DocumentRecord> {
  const document = await context.store.findDocument(documentId);
  if (document === undefined) {
    throw new HttpError(404, "The document does not exist.");
  }
  return document;
}

async function documentNames(
  context: ServerContext,
): Promise<Map<string, string>> {
  const documents = await context.store.listDocuments();
  return new Map(
    documents.map((document) => [document.id, basename(document.sourcePath)]),
  );
}

function toSummary(document: DocumentRecord): DocumentSummary {
  return {
    id: document.id,
    fileName: basename(document.sourcePath),
    pageCount: document.pageCount,
    chunkCount: document.chunkCount,
    ingestedAt: document.ingestedAt,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
