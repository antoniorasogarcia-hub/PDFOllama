import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatModel } from "../src/generation/chat-model.js";
import { SqliteVectorStore } from "../src/store/sqlite-vector-store.js";
import { summarizeDocument } from "../src/summary/document-summary.js";
import {
  groupIntoSections,
  type SummaryEvent,
  summarizeChunks,
  summaryInputBudget,
} from "../src/summary/summarizer.js";
import type { Chunk, DocumentRecord, TextChunk } from "../src/types.js";

describe("summaryInputBudget", () => {
  it("keeps room for the prompt and the answer", () => {
    expect(summaryInputBudget(4096)).toBe((4096 - 1200) * 3);
    expect(summaryInputBudget(512)).toBe(1000);
  });
});

describe("groupIntoSections", () => {
  it("joins consecutive sections while they fit", () => {
    const sections = [1, 2, 3].map((page) => ({
      firstPage: page,
      lastPage: page,
      text: "x".repeat(40),
    }));

    expect(
      groupIntoSections(sections, 100).map((section) => [
        section.firstPage,
        section.lastPage,
      ]),
    ).toEqual([
      [1, 2],
      [3, 3],
    ]);
  });
});

describe("summarizeChunks", () => {
  it("summarizes a short document in a single streamed call", async () => {
    const chatModel = fakeChatModel(() => ["Resumen ", "final."]);

    const events = await collect(
      summarizeChunks([chunk(1, "Uno."), chunk(2, "Dos.")], chatModel, 1000),
    );

    expect(events).toEqual([
      { type: "text_delta", text: "Resumen " },
      { type: "text_delta", text: "final." },
    ]);
    expect(chatModel.calls).toHaveLength(1);
    expect(chatModel.calls[0]?.[0]?.content).toContain("Puntos clave:");
    expect(chatModel.calls[0]?.[1]?.content).toBe(
      "Texto del documento:\n\n[p. 1]\nUno.\n\n[p. 2]\nDos.",
    );
  });

  it("summarizes each section of a long document, then combines them", async () => {
    const chatModel = fakeChatModel((messages) =>
      messages[1]?.content.startsWith("Resúmenes de las partes")
        ? ["Resumen completo."]
        : ["- Punto [p. X]"],
    );
    const chunks = [1, 2, 3, 4].map((page) =>
      chunk(page, `Texto de la página ${page}. `.repeat(10)),
    );

    const events = await collect(summarizeChunks(chunks, chatModel, 600));

    expect(events).toEqual([
      { type: "progress", done: 1, total: 2 },
      { type: "progress", done: 2, total: 2 },
      { type: "text_delta", text: "Resumen completo." },
    ]);
    expect(chatModel.calls).toHaveLength(3);
    expect(chatModel.calls[0]?.[1]?.content).toMatch(/^Texto \(páginas 1-2\)/u);
    expect(chatModel.calls[1]?.[1]?.content).toMatch(/^Texto \(páginas 3-4\)/u);
    expect(chatModel.calls[2]?.[1]?.content).toContain(
      "Resumen de las páginas 1-2:\n- Punto [p. X]",
    );
  });

  it("combines section summaries in several rounds when they do not fit", async () => {
    const longPartial = "p".repeat(250);
    const chatModel = fakeChatModel((messages) =>
      messages[1]?.content.startsWith("Resúmenes de las partes")
        ? ["Final."]
        : [longPartial],
    );
    const chunks = [1, 2, 3, 4, 5, 6, 7, 8].map((page) =>
      chunk(page, "t".repeat(280)),
    );

    const events = await collect(summarizeChunks(chunks, chatModel, 600));

    expect(events.at(-1)).toEqual({ type: "text_delta", text: "Final." });
    // 4 section summaries do not fit together, so they are combined in pairs
    // (2 calls) before the final call.
    expect(chatModel.calls).toHaveLength(4 + 2 + 1);
    const finalInput = chatModel.calls.at(-1)?.[1]?.content ?? "";
    expect(finalInput).toMatch(/^Resúmenes de las partes del documento:/u);
    expect(finalInput).toContain("Resumen de las páginas 1-4:");
    expect(finalInput).toContain("Resumen de las páginas 5-8:");
  });

  it("fails clearly for a document without text", async () => {
    await expect(
      collect(
        summarizeChunks(
          [],
          fakeChatModel(() => []),
          1000,
        ),
      ),
    ).rejects.toThrow("The document has no text to summarize.");
  });
});

describe("summarizeDocument", () => {
  let store: SqliteVectorStore;
  const config = {
    models: { embedding: "fake-embedder", chat: "fake-chat" },
    generation: { temperature: 0, contextWindow: 4096 },
  };

  beforeEach(async () => {
    store = new SqliteVectorStore(":memory:");
    await store.replaceDocument(documentRecord(), [
      embedded(chunk(1, "La empresa tiene 142 empleados.")),
      embedded(chunk(2, "Hay 24 días de vacaciones.")),
    ]);
  });

  afterEach(async () => {
    await store.close();
  });

  it("summarizes a stored document and caches the result", async () => {
    const chatModel = fakeChatModel(() => ["Resumen del manual."]);

    const first = await collect(
      summarizeDocument("doc", { store, chatModel, config }),
    );
    const second = await collect(
      summarizeDocument("doc", { store, chatModel, config }),
    );

    expect(first).toEqual([
      { type: "text_delta", text: "Resumen del manual." },
      { type: "done", cached: false },
    ]);
    expect(second).toEqual([
      { type: "text_delta", text: "Resumen del manual." },
      { type: "done", cached: true },
    ]);
    expect(chatModel.calls).toHaveLength(1);
    expect(chatModel.calls[0]?.[1]?.content).toContain("142 empleados");
  });

  it("regenerates the summary on refresh", async () => {
    let call = 0;
    const chatModel = fakeChatModel(() => [`Versión ${++call}`]);

    await collect(summarizeDocument("doc", { store, chatModel, config }));
    await collect(
      summarizeDocument("doc", { store, chatModel, config }, { refresh: true }),
    );

    await expect(store.findSummary("doc", "fake-chat")).resolves.toBe(
      "Versión 2",
    );
  });

  it("does not cache an empty summary", async () => {
    const chatModel = fakeChatModel(() => ["  "]);

    await collect(summarizeDocument("doc", { store, chatModel, config }));

    await expect(
      store.findSummary("doc", "fake-chat"),
    ).resolves.toBeUndefined();
  });
});

function chunk(pageNumber: number, text: string): TextChunk {
  return { id: `doc:${pageNumber}:0`, documentId: "doc", pageNumber, text };
}

function embedded(textChunk: TextChunk): Chunk {
  return { ...textChunk, embedding: [1, 0] };
}

function documentRecord(): DocumentRecord {
  return {
    id: "doc",
    sourcePath: "/docs/manual.pdf",
    pageCount: 2,
    chunkCount: 2,
    embeddingModel: "fake-embedder",
    chunkSize: 450,
    chunkOverlap: 75,
    ingestedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fakeChatModel(
  reply: (messages: readonly ChatMessage[]) => string[],
): ChatModel & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    stream: vi.fn(async function* (messages: readonly ChatMessage[]) {
      calls.push([...messages]);
      yield* reply(messages);
    }),
  };
}

async function collect<T extends SummaryEvent | { type: string }>(
  iterable: AsyncIterable<T>,
): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}
