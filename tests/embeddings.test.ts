import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaEmbedder } from "../src/embeddings/ollama-embedder.js";

const connection = {
  baseUrl: "http://ollama.test",
  timeoutMs: 50,
  model: "bge-m3",
};

describe("OllamaEmbedder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends all texts in one request and returns their vectors", async () => {
    const fetchMock = stubFetch(
      Response.json({
        embeddings: [
          [0.1, 0.2],
          [0.3, 0.4],
        ],
      }),
    );

    const embeddings = await new OllamaEmbedder(connection).embedMany([
      "a",
      "b",
    ]);

    expect(embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://ollama.test/api/embed");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "bge-m3",
      input: ["a", "b"],
    });
  });

  it("embeds a single text", async () => {
    stubFetch(Response.json({ embeddings: [[1, 2, 3]] }));

    await expect(new OllamaEmbedder(connection).embed("hola")).resolves.toEqual(
      [1, 2, 3],
    );
  });

  it("does not call Ollama for an empty list", async () => {
    const fetchMock = stubFetch(Response.json({ embeddings: [] }));

    await expect(new OllamaEmbedder(connection).embedMany([])).resolves.toEqual(
      [],
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects responses with an unexpected format", async () => {
    stubFetch(Response.json({ embeddings: [[1], "oops"] }));

    await expect(
      new OllamaEmbedder(connection).embedMany(["a", "b"]),
    ).rejects.toThrow("Unexpected embedding response from Ollama");
  });

  it("explains how to fix a missing model", async () => {
    stubFetch(
      Response.json({ error: 'model "bge-m3" not found' }, { status: 404 }),
    );

    await expect(new OllamaEmbedder(connection).embed("a")).rejects.toThrow(
      'Ollama returned HTTP 404: model "bge-m3" not found. Download it with "ollama pull <model>".',
    );
  });

  it("reports when Ollama is not running", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    await expect(new OllamaEmbedder(connection).embed("a")).rejects.toThrow(
      "Could not connect to Ollama at http://ollama.test",
    );
  });

  it("reports a timeout when Ollama does not answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );

    await expect(new OllamaEmbedder(connection).embed("a")).rejects.toThrow(
      "Ollama did not respond within 50 ms",
    );
  });
});

function stubFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
