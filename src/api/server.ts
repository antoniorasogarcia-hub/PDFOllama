import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../config.js";
import type { Embedder } from "../embeddings/embedder.js";
import type { ChatModel } from "../generation/chat-model.js";
import type { VectorStore } from "../store/vector-store.js";
import type { SummaryCache } from "../summary/summary-cache.js";
import { HttpError, sendJson } from "./http-io.js";
import {
  ask,
  deleteDocument,
  listDocuments,
  summarize,
  uploadDocument,
} from "./routes.js";

export interface ServerContext {
  config: AppConfig;
  embedder: Embedder;
  store: VectorStore & SummaryCache;
  chatModel: ChatModel;
}

/** The server only listens on the loopback interface. */
export const SERVER_HOST = "127.0.0.1";

const PUBLIC_DIRECTORY = new URL("../../public/", import.meta.url);

const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
};

/**
 * Creates the HTTP server for the web interface. Uploads and questions run one
 * at a time, because a CPU-only Ollama is much slower with parallel requests.
 */
export function createApiServer(context: ServerContext): Server {
  const runExclusive = createSerialQueue();

  const server = createServer((request, response) => {
    handleRequest(request, response, context, server, runExclusive).catch(
      (error: unknown) => sendError(response, error),
    );
  });
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: ServerContext,
  server: Server,
  runExclusive: SerialQueue,
): Promise<void> {
  assertLocalHost(request, server);
  const url = new URL(request.url ?? "/", "http://localhost");
  const route = `${request.method} ${url.pathname}`;

  const staticFile = STATIC_FILES[url.pathname];
  if (request.method === "GET" && staticFile !== undefined) {
    return sendStaticFile(response, staticFile.file, staticFile.contentType);
  }
  if (route === "GET /api/documents") {
    return listDocuments(request, response, context);
  }
  if (route === "POST /api/documents") {
    return runExclusive(() => uploadDocument(request, response, context, url));
  }
  if (route === "POST /api/ask") {
    return runExclusive(() => ask(request, response, context));
  }
  const documentMatch = /^\/api\/documents\/([0-9a-f]{64})$/u.exec(
    url.pathname,
  );
  if (request.method === "DELETE" && documentMatch?.[1] !== undefined) {
    return deleteDocument(response, context, documentMatch[1]);
  }
  const summaryMatch = /^\/api\/documents\/([0-9a-f]{64})\/summary$/u.exec(
    url.pathname,
  );
  if (request.method === "POST" && summaryMatch?.[1] !== undefined) {
    const documentId = summaryMatch[1];
    return runExclusive(() =>
      summarize(request, response, context, documentId),
    );
  }
  throw new HttpError(404, "Not found.");
}

/**
 * Rejects requests addressed to another host name, which protects the local
 * server from DNS rebinding attacks by websites open in the browser.
 */
function assertLocalHost(request: IncomingMessage, server: Server): void {
  const { port } = server.address() as AddressInfo;
  const allowed = [`localhost:${port}`, `${SERVER_HOST}:${port}`];
  if (!allowed.includes(request.headers.host ?? "")) {
    throw new HttpError(403, "Requests are only accepted from localhost.");
  }
}

async function sendStaticFile(
  response: ServerResponse,
  file: string,
  contentType: string,
): Promise<void> {
  const content = await readFile(new URL(file, PUBLIC_DIRECTORY));
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'",
  });
  response.end(content);
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  sendJson(response, 500, {
    error: error instanceof Error ? error.message : String(error),
  });
}

type SerialQueue = (task: () => Promise<void>) => Promise<void>;

/** Runs tasks one after another, in the order they were submitted. */
function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}
