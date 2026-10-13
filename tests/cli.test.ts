import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliContext, runCli } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { NO_ANSWER } from "../src/generation/prompt.js";
import { SqliteVectorStore } from "../src/store/sqlite-vector-store.js";
import { createPdf } from "./fixtures/pdf-builder.js";
import { samplePages } from "./fixtures/sample-document.js";

describe("cli", () => {
  let testDirectory: string;
  let pdfPath: string;
  let context: CliContext;
  let output: string;

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), "pdf-ollama-cli-"));
    pdfPath = join(testDirectory, "manual.pdf");
    await writeFile(pdfPath, createPdf(samplePages));
    output = "";
    context = {
      config: loadConfig({ PDF_OLLAMA_EMBEDDING_MODEL: "fake-embedder" }),
      // Only the vacations page shares the question's vector, so it ranks first.
      embedder: {
        embed: vi.fn(async () => [0, 1]),
        embedMany: vi.fn(async (texts: readonly string[]) =>
          texts.map((text) =>
            text.includes("vacaciones al año") ? [0, 1] : [1, 0],
          ),
        ),
      },
      store: new SqliteVectorStore(":memory:"),
      chatModel: {
        stream: vi.fn(async function* () {
          yield "Tienes 24 días laborables [p. 2].";
        }),
      },
      input: Readable.from([]),
      output: { write: (text: string) => (output += text) },
    };
  });

  afterEach(async () => {
    await context.store.close();
    await rm(testDirectory, { recursive: true, force: true });
  });

  it("ingests a PDF, warns about pages without text, and lists it", async () => {
    await runCli(["ingest", pdfPath], context);
    await runCli(["list"], context);

    expect(output).toContain("Warning: no text on pages 6.");
    expect(output).toMatch(/[0-9a-f]{8} {2}manual\.pdf {2}7 pages/u);
  });

  it("answers a question with the cited sources", async () => {
    await runCli(["ingest", pdfPath], context);
    output = "";

    await runCli(["ask", "¿Cuántos", "días", "de", "vacaciones?"], context);

    expect(output).toBe(
      "Tienes 24 días laborables [p. 2].\nSources: manual.pdf (p. 2)\n",
    );
  });

  it("shows no sources when the answer is not in the document", async () => {
    await runCli(["ingest", pdfPath], context);
    context.chatModel = {
      async *stream() {
        yield NO_ANSWER;
      },
    };
    output = "";

    await runCli(["ask", "¿Quién es el director financiero?"], context);

    expect(output).toBe(`${NO_ANSWER}\n`);
  });

  it("answers several questions in chat mode", async () => {
    await runCli(["ingest", pdfPath], context);
    context.input = Readable.from([
      "¿Vacaciones?\n",
      "\n",
      "¿Y teletrabajo?\n",
      "exit\n",
    ]);
    output = "";

    await runCli(["chat"], context);

    expect(output.match(/Tienes 24 días/gu)).toHaveLength(2);
  });

  it("summarizes a whole document and reuses the saved summary", async () => {
    await runCli(["ingest", pdfPath], context);
    output = "";

    await runCli(["summarize", "manual.pdf"], context);
    const first = output;
    output = "";
    await runCli(["summarize", "manual.pdf"], context);

    expect(first).toBe("Tienes 24 días laborables [p. 2].\n");
    expect(output).toBe(
      "Tienes 24 días laborables [p. 2].\n(Saved summary. Use --refresh to regenerate it.)\n",
    );
    await expect(runCli(["summarize"], context)).rejects.toThrow(
      "summarize needs a document id prefix or file name.",
    );
  });

  it("refuses to search documents indexed with another embedding model", async () => {
    await runCli(["ingest", pdfPath], context);
    context.config = loadConfig({ PDF_OLLAMA_EMBEDDING_MODEL: "other-model" });

    await expect(runCli(["ask", "¿Vacaciones?"], context)).rejects.toThrow(
      "manual.pdf was indexed with a different embedding model than other-model",
    );
  });

  it("removes a document by file name", async () => {
    await runCli(["ingest", pdfPath], context);

    await runCli(["remove", "manual.pdf"], context);

    expect(output).toContain("Removed manual.pdf");
    await expect(context.store.listDocuments()).resolves.toEqual([]);
  });

  it("rejects unknown commands and invalid options", async () => {
    await expect(runCli(["bogus"], context)).rejects.toThrow(
      'Unknown command "bogus".',
    );
    await expect(
      runCli(["search", "x", "--top-k", "0"], context),
    ).rejects.toThrow("--top-k must be a positive integer.");
    await expect(runCli(["remove", "missing.pdf"], context)).rejects.toThrow(
      'No indexed document matches "missing.pdf"',
    );
  });
});
