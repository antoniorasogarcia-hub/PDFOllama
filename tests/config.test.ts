import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  it("provides conservative defaults", () => {
    const config = loadConfig({});

    expect(config.models).toEqual({ embedding: "bge-m3", chat: "llama3.2:3b" });
    expect(config.chunking).toEqual({ size: 450, overlap: 75 });
    expect(config.retrieval.topK).toBe(3);
    expect(config.ollama.baseUrl).toBe("http://localhost:11434");
    expect(config.paths.databaseFile).toBe("data/pdf-ollama.db");
    expect(config.server).toEqual({ port: 3000, maxUploadBytes: 104857600 });
  });

  it("applies environment overrides", () => {
    const config = loadConfig({
      PDF_OLLAMA_CHAT_MODEL: "llama3.2:1b",
      PDF_OLLAMA_TOP_K: "5",
      PDF_OLLAMA_DATA_DIR: "/tmp/rag",
      OLLAMA_BASE_URL: "http://gpu-box:11434/",
    });

    expect(config.models.chat).toBe("llama3.2:1b");
    expect(config.retrieval.topK).toBe(5);
    expect(config.paths.databaseFile).toBe("/tmp/rag/pdf-ollama.db");
    expect(config.ollama.baseUrl).toBe("http://gpu-box:11434");
  });

  it("rejects values that are not valid numbers", () => {
    expect(() => loadConfig({ PDF_OLLAMA_TOP_K: "abc" })).toThrow(
      'PDF_OLLAMA_TOP_K must be a number >= 1, got "abc".',
    );
    expect(() => loadConfig({ PDF_OLLAMA_CHUNK_SIZE: "1.5" })).toThrow(
      "PDF_OLLAMA_CHUNK_SIZE must be an integer",
    );
  });

  it("rejects an overlap that is not smaller than the chunk size", () => {
    expect(() =>
      loadConfig({
        PDF_OLLAMA_CHUNK_SIZE: "100",
        PDF_OLLAMA_CHUNK_OVERLAP: "100",
      }),
    ).toThrow("PDF_OLLAMA_CHUNK_OVERLAP must be smaller");
  });
});
