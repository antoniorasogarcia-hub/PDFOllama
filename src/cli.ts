#!/usr/bin/env node
import { basename } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  createApiServer,
  SERVER_HOST,
  type ServerContext,
} from "./api/server.js";
import { type AppConfig, loadConfig } from "./config.js";
import { OllamaEmbedder } from "./embeddings/ollama-embedder.js";
import { generateAnswer } from "./generation/answer-generator.js";
import { OllamaChatModel } from "./generation/ollama-chat-model.js";
import { indexPdf } from "./ingest/index-document.js";
import {
  assertEmbeddingModelMatches,
  retrieveRelevantChunks,
} from "./retrieval/retrieval.js";
import { SqliteVectorStore } from "./store/sqlite-vector-store.js";
import type { VectorStore } from "./store/vector-store.js";
import type { Citation, DocumentRecord, SearchFilter } from "./types.js";

const USAGE = `Usage: pdf-ollama <command> [options]

Commands:
  ingest <file.pdf>...     Index one or more PDFs
  list                     List indexed documents
  remove <document>        Remove a document (id prefix or file name)
  search "<text>"          Show the chunks most similar to a text
  ask "<question>"         Answer a question with page citations
  chat                     Ask several questions interactively
  serve                    Start the web interface on http://localhost:3000

Options:
  --doc <document>         Limit search to one document (id prefix or file name)
  --top-k <n>              Number of chunks to retrieve (default: PDF_OLLAMA_TOP_K)
  --show-context           Print the retrieved chunks before the answer

Configuration is read from environment variables (see ARCHITECTURE.md).`;

export interface CliContext extends ServerContext {
  input: NodeJS.ReadableStream;
  output: { write(text: string): unknown };
}

/** Runs one CLI command against the given dependencies. */
export async function runCli(
  args: readonly string[],
  context: CliContext,
): Promise<void> {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      doc: { type: "string" },
      "top-k": { type: "string" },
      "show-context": { type: "boolean" },
    },
  });
  const [command, ...rest] = positionals;

  switch (command) {
    case "ingest":
      return ingestCommand(rest, context);
    case "list":
      return listCommand(context);
    case "remove":
      return removeCommand(rest, context);
    case "search":
      return searchCommand(rest.join(" "), values, context);
    case "ask":
      return askCommand(rest.join(" "), values, context);
    case "chat":
      return chatCommand(values, context);
    case "serve":
      return serveCommand(context);
    default:
      context.output.write(`${USAGE}\n`);
      if (command !== undefined && command !== "help") {
        throw new UsageError(`Unknown command "${command}".`);
      }
  }
}

async function ingestCommand(
  files: readonly string[],
  context: CliContext,
): Promise<void> {
  if (files.length === 0) {
    throw new UsageError("ingest needs at least one PDF file.");
  }

  for (const file of files) {
    context.output.write(`Indexing ${file}...\n`);
    const startedAt = Date.now();
    const result = await indexPdf(file, {
      ...context,
      onProgress: (done, total) =>
        context.output.write(`  embedded ${done}/${total} chunks\n`),
    });

    const { document } = result;
    if (result.status === "unchanged") {
      context.output.write(
        `  Already indexed with the same settings (${shortId(document)}). Skipped.\n`,
      );
      continue;
    }
    context.output.write(
      `  Done in ${((Date.now() - startedAt) / 1000).toFixed(1)} s: ${document.pageCount} pages, ${document.chunkCount} chunks (${shortId(document)}).\n`,
    );
    if (result.pagesWithoutText.length > 0) {
      context.output.write(
        `  Warning: no text on pages ${result.pagesWithoutText.join(", ")}. They may be scanned images; run OCR first (e.g. ocrmypdf) to include them.\n`,
      );
    }
  }
}

async function listCommand(context: CliContext): Promise<void> {
  const documents = await context.store.listDocuments();
  if (documents.length === 0) {
    context.output.write(
      "No documents indexed yet. Use: pdf-ollama ingest <file.pdf>\n",
    );
    return;
  }
  for (const document of documents) {
    context.output.write(
      `${shortId(document)}  ${basename(document.sourcePath)}  ${document.pageCount} pages, ${document.chunkCount} chunks, ${document.embeddingModel}, ${document.ingestedAt}\n`,
    );
  }
}

async function removeCommand(
  references: readonly string[],
  context: CliContext,
): Promise<void> {
  const [reference] = references;
  if (reference === undefined) {
    throw new UsageError("remove needs a document id prefix or file name.");
  }
  const document = await findDocumentByReference(reference, context.store);
  await context.store.deleteByDocumentId(document.id);
  context.output.write(
    `Removed ${basename(document.sourcePath)} (${shortId(document)}).\n`,
  );
}

interface QueryOptions {
  doc?: string | undefined;
  "top-k"?: string | undefined;
  "show-context"?: boolean | undefined;
}

async function searchCommand(
  text: string,
  options: QueryOptions,
  context: CliContext,
): Promise<void> {
  const chunks = await retrieve(text, options, context);
  if (chunks.length === 0) {
    context.output.write("No documents indexed yet.\n");
    return;
  }
  await printChunks(chunks, context);
}

async function askCommand(
  question: string,
  options: QueryOptions,
  context: CliContext,
): Promise<void> {
  const chunks = await retrieve(question, options, context);
  if (options["show-context"]) {
    await printChunks(chunks, context);
    context.output.write("\n");
  }

  for await (const event of generateAnswer(
    question,
    chunks,
    context.chatModel,
  )) {
    if (event.type === "text_delta") {
      context.output.write(event.text);
    } else {
      context.output.write(
        `\n${await formatCitations(event.citations, context.store)}`,
      );
    }
  }
}

async function chatCommand(
  options: QueryOptions,
  context: CliContext,
): Promise<void> {
  context.output.write(
    'Ask a question about your PDFs. Type "exit" or press Ctrl+D to quit.\n\n> ',
  );
  const lines = createInterface({ input: context.input, terminal: false });
  for await (const line of lines) {
    const question = line.trim();
    if (question === "exit" || question === "quit") {
      break;
    }
    if (question !== "") {
      try {
        await askCommand(question, options, context);
      } catch (error) {
        context.output.write(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    context.output.write("\n> ");
  }
  lines.close();
}

async function retrieve(
  text: string,
  options: QueryOptions,
  context: CliContext,
) {
  await assertEmbeddingModelMatches(
    context.store,
    context.config.models.embedding,
  );
  return retrieveRelevantChunks(
    text,
    context.embedder,
    context.store,
    readTopK(options, context.config),
    await readSearchFilter(options, context.store),
  );
}

async function printChunks(
  chunks: Awaited<ReturnType<typeof retrieveRelevantChunks>>,
  context: CliContext,
): Promise<void> {
  const names = await documentNames(context.store);
  for (const [index, chunk] of chunks.entries()) {
    context.output.write(
      `\n#${index + 1}  score ${chunk.score.toFixed(3)}  ${names.get(chunk.documentId)} p. ${chunk.pageNumber}\n${chunk.text}\n`,
    );
  }
}

async function formatCitations(
  citations: readonly Citation[],
  store: VectorStore,
): Promise<string> {
  if (citations.length === 0) {
    return "";
  }
  const names = await documentNames(store);
  const pagesByDocument = new Map<string, number[]>();
  for (const { documentId, pageNumber } of citations) {
    const name = names.get(documentId) ?? documentId.slice(0, 8);
    pagesByDocument.set(name, [
      ...(pagesByDocument.get(name) ?? []),
      pageNumber,
    ]);
  }
  const sources = [...pagesByDocument].map(
    ([name, pages]) => `${name} (p. ${pages.sort((a, b) => a - b).join(", ")})`,
  );
  return `Sources: ${sources.join("; ")}\n`;
}

function readTopK(options: QueryOptions, config: AppConfig): number {
  if (options["top-k"] === undefined) {
    return config.retrieval.topK;
  }
  const topK = Number(options["top-k"]);
  if (!Number.isInteger(topK) || topK < 1) {
    throw new UsageError("--top-k must be a positive integer.");
  }
  return topK;
}

async function readSearchFilter(
  options: QueryOptions,
  store: VectorStore,
): Promise<SearchFilter> {
  if (options.doc === undefined) {
    return {};
  }
  return { documentId: (await findDocumentByReference(options.doc, store)).id };
}

async function documentNames(store: VectorStore): Promise<Map<string, string>> {
  const documents = await store.listDocuments();
  return new Map(
    documents.map((document) => [document.id, basename(document.sourcePath)]),
  );
}

/** Starts the web server and keeps running until Ctrl+C. */
async function serveCommand(context: CliContext): Promise<void> {
  const { port } = context.config.server;
  const server = createApiServer(context);
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new UsageError(
              `Port ${port} is already in use. Set PDF_OLLAMA_PORT to another port.`,
            )
          : error,
      ),
    );
    server.listen(port, SERVER_HOST, resolve);
  });
  context.output.write(
    `PDF Ollama is running at http://localhost:${port} (press Ctrl+C to stop)\n`,
  );

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });
}

/** Resolves a document from an id prefix or a file name. */
export async function findDocumentByReference(
  reference: string,
  store: VectorStore,
): Promise<DocumentRecord> {
  const matches = (await store.listDocuments()).filter(
    (document) =>
      document.id.startsWith(reference) ||
      basename(document.sourcePath) === reference,
  );
  const [match] = matches;
  if (match === undefined) {
    throw new UsageError(
      `No indexed document matches "${reference}". Run "list" to see them.`,
    );
  }
  if (matches.length > 1) {
    throw new UsageError(
      `"${reference}" matches several documents; use a longer id prefix.`,
    );
  }
  return match;
}

function shortId(document: DocumentRecord): string {
  return document.id.slice(0, 8);
}

/** An error caused by wrong CLI input. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Starts the command-line application. */
export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  let store: VectorStore | undefined;
  try {
    const config = loadConfig();
    store = new SqliteVectorStore(config.paths.databaseFile);
    const embedder = new OllamaEmbedder({
      ...config.ollama,
      model: config.models.embedding,
    });
    const chatModel = new OllamaChatModel({
      ...config.ollama,
      ...config.generation,
      model: config.models.chat,
    });
    await runCli(args, {
      config,
      embedder,
      store,
      chatModel,
      input: process.stdin,
      output: process.stdout,
    });
  } catch (error) {
    process.stderr.write(
      `Error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    await store?.close();
  }
}

if (import.meta.main) {
  await main();
}
