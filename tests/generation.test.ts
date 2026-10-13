import { afterEach, describe, expect, it, vi } from "vitest";
import { generateAnswer } from "../src/generation/answer-generator.js";
import type { ChatMessage, ChatModel } from "../src/generation/chat-model.js";
import { OllamaChatModel } from "../src/generation/ollama-chat-model.js";
import {
  buildMessages,
  isNoAnswer,
  NO_ANSWER,
} from "../src/generation/prompt.js";
import type { RetrievedChunk } from "../src/types.js";

const chunks: RetrievedChunk[] = [
  chunk("doc-a", 3, "La ayuda es de 35 euros mensuales."),
  chunk("doc-a", 2, "Hay 24 días laborables de vacaciones."),
  chunk("doc-a", 3, "Los martes son presenciales."),
  chunk("doc-b", 9, "Texto de otro documento."),
];

describe("buildMessages", () => {
  it("grounds the question in the chunks, labelled with their pages", () => {
    const [system, user] = buildMessages(
      "  ¿Cuánto es la ayuda? ",
      chunks.slice(0, 2),
    );

    expect(system?.role).toBe("system");
    expect(system?.content).toContain(
      "Responde únicamente con la información de los fragmentos",
    );
    expect(system?.content).toContain(NO_ANSWER);
    expect(user).toEqual({
      role: "user",
      content:
        "Fragmentos del documento:\n\n[p. 3]\nLa ayuda es de 35 euros mensuales.\n\n[p. 2]\nHay 24 días laborables de vacaciones.\n\nPregunta: ¿Cuánto es la ayuda?",
    });
  });
});

describe("isNoAnswer", () => {
  it.each([
    NO_ANSWER,
    "  «No lo sé.»",
    "No sé: el documento no lo dice",
    "I don't know.",
  ])("detects %j", (text) => expect(isNoAnswer(text)).toBe(true));

  it("does not flag answers that mention not knowing later on", () => {
    expect(
      isNoAnswer("La ayuda es de 35 euros [p. 3]. No sé si incluye IVA."),
    ).toBe(false);
  });
});

describe("generateAnswer", () => {
  it("streams text deltas and then the pages the answer cites", async () => {
    const events = await collect(
      generateAnswer(
        "¿Ayuda?",
        chunks,
        fakeChatModel(["La ayuda es ", "de 35 euros [p. 3]."]),
      ),
    );

    expect(events).toEqual([
      { type: "text_delta", text: "La ayuda es " },
      { type: "text_delta", text: "de 35 euros [p. 3]." },
      {
        type: "citations",
        citations: [{ documentId: "doc-a", pageNumber: 3 }],
      },
    ]);
  });

  it("cites every retrieved page once when the answer cites none", async () => {
    const events = await collect(
      generateAnswer("¿Ayuda?", chunks, fakeChatModel(["35 euros."])),
    );

    expect(events.at(-1)).toEqual({
      type: "citations",
      citations: [
        { documentId: "doc-a", pageNumber: 3 },
        { documentId: "doc-a", pageNumber: 2 },
        { documentId: "doc-b", pageNumber: 9 },
      ],
    });
  });

  it("ignores cited pages that were not retrieved", async () => {
    const events = await collect(
      generateAnswer("¿Ayuda?", chunks, fakeChatModel(["35 euros [p. 42]."])),
    );

    expect(events.at(-1)).toMatchObject({ citations: { length: 3 } });
  });

  it("returns no citations when the answer is not in the document", async () => {
    const events = await collect(
      generateAnswer(
        "¿Quién es el director?",
        chunks,
        fakeChatModel([NO_ANSWER]),
      ),
    );

    expect(events.at(-1)).toEqual({ type: "citations", citations: [] });
  });

  it("says it does not know without calling the model when nothing was retrieved", async () => {
    const chatModel = fakeChatModel(["unused"]);

    const events = await collect(generateAnswer("¿Algo?", [], chatModel));

    expect(events).toEqual([
      { type: "text_delta", text: NO_ANSWER },
      { type: "citations", citations: [] },
    ]);
    expect(chatModel.stream).not.toHaveBeenCalled();
  });
});

describe("OllamaChatModel", () => {
  const config = {
    baseUrl: "http://ollama.test",
    timeoutMs: 50,
    temperature: 0,
    contextWindow: 4096,
    model: "llama3.2:3b",
  };
  const messages: ChatMessage[] = [{ role: "user", content: "Hola" }];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams message content from Ollama NDJSON, even when lines are split", async () => {
    const fetchMock = stubFetch([
      '{"message":{"content":"Ho"}}\n{"message":{"con',
      'tent":"la"}}\n',
      '{"message":{"content":""},"done":true}\n',
    ]);

    await expect(
      collect(new OllamaChatModel(config).stream(messages)),
    ).resolves.toEqual(["Ho", "la"]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://ollama.test/api/chat");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "llama3.2:3b",
      messages,
      stream: true,
      options: { temperature: 0, num_ctx: 4096 },
    });
  });

  it("reports errors sent inside the stream", async () => {
    stubFetch(['{"error":"model requires more system memory"}\n']);

    await expect(
      collect(new OllamaChatModel(config).stream(messages)),
    ).rejects.toThrow(
      "Ollama failed while generating: model requires more system memory",
    );
  });

  it("rejects lines that are not JSON", async () => {
    stubFetch(["<html>proxy error</html>\n"]);

    await expect(
      collect(new OllamaChatModel(config).stream(messages)),
    ).rejects.toThrow("Unexpected chat response from Ollama");
  });

  it("reports a stream that ends before the answer is done", async () => {
    stubFetch(['{"message":{"content":"Ho"}}\n']);

    await expect(
      collect(new OllamaChatModel(config).stream(messages)),
    ).rejects.toThrow("Ollama closed the stream before finishing the answer.");
  });

  function stubFetch(parts: string[]) {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(encoder.encode(part));
        }
        controller.close();
      },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
});

function chunk(
  documentId: string,
  pageNumber: number,
  text: string,
): RetrievedChunk {
  return {
    id: `${documentId}:${pageNumber}:${text.length}`,
    documentId,
    pageNumber,
    text,
    score: 0.5,
  };
}

function fakeChatModel(
  parts: string[],
): ChatModel & { stream: ReturnType<typeof vi.fn> } {
  return {
    stream: vi.fn(async function* () {
      yield* parts;
    }),
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}
