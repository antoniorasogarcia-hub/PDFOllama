import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeFileName } from "../src/api/routes.js";
import {
  createApiServer,
  SERVER_HOST,
  type ServerContext,
} from "../src/api/server.js";
import { loadConfig } from "../src/config.js";
import { NO_ANSWER } from "../src/generation/prompt.js";
import { SqliteVectorStore } from "../src/store/sqlite-vector-store.js";
import { createPdf } from "./fixtures/pdf-builder.js";
import { samplePages } from "./fixtures/sample-document.js";

describe("web API", () => {
  let context: ServerContext;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    context = {
      config: loadConfig({
        PDF_OLLAMA_EMBEDDING_MODEL: "fake-embedder",
        PDF_OLLAMA_MAX_UPLOAD_MB: "1",
      }),
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
          yield "Tienes 24 días ";
          yield "laborables [p. 2].";
        }),
      },
    };
    server = createApiServer(context);
    await new Promise<void>((resolve) =>
      server.listen(0, SERVER_HOST, resolve),
    );
    baseUrl = `http://${SERVER_HOST}:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await context.store.close();
  });

  describe("documents", () => {
    it("starts with no documents", async () => {
      const response = await fetch(`${baseUrl}/api/documents`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual([]);
    });

    it("uploads a PDF with streamed progress and lists it", async () => {
      const events = await upload("Mi manual.pdf", createPdf(samplePages));

      expect(events[0]).toEqual({ type: "started", fileName: "Mi manual.pdf" });
      expect(events.some((event) => event.type === "progress")).toBe(true);
      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "indexed",
        pagesWithoutText: [6],
        document: { fileName: "Mi manual.pdf", pageCount: 7 },
      });

      const documents = await (await fetch(`${baseUrl}/api/documents`)).json();
      expect(documents).toEqual([
        expect.objectContaining({ fileName: "Mi manual.pdf", pageCount: 7 }),
      ]);
    });

    it("does not duplicate a PDF uploaded twice", async () => {
      await upload("manual.pdf", createPdf(samplePages));

      const events = await upload("manual.pdf", createPdf(samplePages));

      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "unchanged",
      });
      await expect(context.store.listDocuments()).resolves.toHaveLength(1);
    });

    it("reports files that are not PDFs as an error event", async () => {
      const events = await upload("notas.pdf", Buffer.from("hola"));

      expect(events.at(-1)).toEqual({
        type: "error",
        message: "Input file is not a PDF (missing %PDF- header).",
      });
    });

    it("rejects uploads that are not sent as PDF", async () => {
      const response = await fetch(`${baseUrl}/api/documents?name=a.pdf`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "%PDF-",
      });

      expect(response.status).toBe(415);
    });

    it("rejects uploads larger than the configured limit", async () => {
      const response = await fetch(`${baseUrl}/api/documents?name=big.pdf`, {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: Buffer.alloc(2 * 1024 * 1024, "%PDF-"),
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error:
          "The file is larger than the 1 MB limit (PDF_OLLAMA_MAX_UPLOAD_MB).",
      });
    });

    it("deletes a document", async () => {
      const events = await upload("manual.pdf", createPdf(samplePages));
      const { id } = (events.at(-1) as { document: { id: string } }).document;

      const first = await fetch(`${baseUrl}/api/documents/${id}`, {
        method: "DELETE",
      });
      const second = await fetch(`${baseUrl}/api/documents/${id}`, {
        method: "DELETE",
      });

      expect(first.status).toBe(204);
      expect(second.status).toBe(404);
      await expect(context.store.listDocuments()).resolves.toEqual([]);
    });
  });

  describe("ask", () => {
    it("streams the answer and then the citations with file names", async () => {
      await upload("manual.pdf", createPdf(samplePages));

      const events = await askQuestion({
        question: "¿Cuántos días de vacaciones?",
      });

      expect(events).toEqual([
        { type: "text_delta", text: "Tienes 24 días " },
        { type: "text_delta", text: "laborables [p. 2]." },
        {
          type: "citations",
          citations: [
            {
              documentId: expect.any(String),
              fileName: "manual.pdf",
              pageNumber: 2,
            },
          ],
        },
      ]);
    });

    it("answers that it does not know when nothing is indexed", async () => {
      const events = await askQuestion({ question: "¿Algo?" });

      expect(events).toEqual([
        { type: "text_delta", text: NO_ANSWER },
        { type: "citations", citations: [] },
      ]);
    });

    it("reports Ollama failures as an error event", async () => {
      await upload("manual.pdf", createPdf(samplePages));
      context.chatModel.stream = () => {
        throw new Error("Could not connect to Ollama.");
      };

      const events = await askQuestion({ question: "¿Vacaciones?" });

      expect(events).toEqual([
        { type: "error", message: "Could not connect to Ollama." },
      ]);
    });

    it("validates the request", async () => {
      const post = (body: string, contentType = "application/json") =>
        fetch(`${baseUrl}/api/ask`, {
          method: "POST",
          headers: { "content-type": contentType },
          body,
        });

      expect((await post("{not json")).status).toBe(400);
      expect((await post(JSON.stringify({ question: "  " }))).status).toBe(400);
      expect(
        (await post(JSON.stringify({ question: "x".repeat(2001) }))).status,
      ).toBe(400);
      expect(
        (
          await post(
            JSON.stringify({ question: "¿Algo?", documentId: "a".repeat(64) }),
          )
        ).status,
      ).toBe(404);
      expect(
        (await post(JSON.stringify({ question: "¿Algo?" }), "text/plain"))
          .status,
      ).toBe(415);
    });

    it("answers one question at a time", async () => {
      let active = 0;
      let maxActive = 0;
      context.chatModel.stream = async function* () {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield "ok";
        active -= 1;
      };
      await upload("manual.pdf", createPdf(samplePages));

      await Promise.all([
        askQuestion({ question: "uno" }),
        askQuestion({ question: "dos" }),
        askQuestion({ question: "tres" }),
      ]);

      expect(maxActive).toBe(1);
    });
  });

  describe("summary", () => {
    async function summarizeRequest(
      id: string,
      body = "{}",
      contentType = "application/json",
    ) {
      return fetch(`${baseUrl}/api/documents/${id}/summary`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      });
    }

    it("streams a summary and serves it from the cache the second time", async () => {
      const uploaded = await upload("manual.pdf", createPdf(samplePages));
      const { id } = (uploaded.at(-1) as { document: { id: string } }).document;

      const first = await readEvents(await summarizeRequest(id));
      const second = await readEvents(await summarizeRequest(id));
      const refreshed = await readEvents(
        await summarizeRequest(id, JSON.stringify({ refresh: true })),
      );

      expect(first).toEqual([
        { type: "text_delta", text: "Tienes 24 días " },
        { type: "text_delta", text: "laborables [p. 2]." },
        { type: "done", cached: false },
      ]);
      expect(second).toEqual([
        { type: "text_delta", text: "Tienes 24 días laborables [p. 2]." },
        { type: "done", cached: true },
      ]);
      expect(refreshed.at(-1)).toEqual({ type: "done", cached: false });
      expect(context.chatModel.stream).toHaveBeenCalledTimes(2);
    });

    it("validates the request", async () => {
      const uploaded = await upload("manual.pdf", createPdf(samplePages));
      const { id } = (uploaded.at(-1) as { document: { id: string } }).document;

      expect((await summarizeRequest("a".repeat(64))).status).toBe(404);
      expect((await summarizeRequest(id, "{}", "text/plain")).status).toBe(415);
      expect(
        (await summarizeRequest(id, JSON.stringify({ refresh: "yes" }))).status,
      ).toBe(400);
    });
  });

  it("rejects requests addressed to another host", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest(
        `${baseUrl}/api/documents`,
        { headers: { host: "evil.example:80" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      )
        .on("error", reject)
        .end();
    });

    expect(status).toBe(403);
  });

  it("serves the web interface with a strict content security policy", async () => {
    const page = await fetch(`${baseUrl}/`);
    const script = await fetch(`${baseUrl}/app.js`);
    const styles = await fetch(`${baseUrl}/styles.css`);

    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(
      "default-src 'self'",
    );
    expect(await page.text()).toContain("Arrastra tus PDFs aquí");
    expect(script.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(styles.status).toBe(200);
  });

  it("returns 404 for unknown routes", async () => {
    expect((await fetch(`${baseUrl}/api/unknown`)).status).toBe(404);
  });

  async function upload(name: string, body: Buffer) {
    const response = await fetch(
      `${baseUrl}/api/documents?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: new Uint8Array(body),
      },
    );
    expect(response.status).toBe(200);
    return readEvents(response);
  }

  async function askQuestion(body: unknown) {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return readEvents(response);
  }
});

describe("sanitizeFileName", () => {
  it.each([
    ["Contrato 2026 (firmado).pdf", "Contrato 2026 (firmado).pdf"],
    ["../../etc/passwd", "passwd.pdf"],
    ["C:\\Users\\ana\\informe.PDF", "informe.PDF"],
    ["año<>:|?*.pdf", "año______.pdf"],
    [".oculto.pdf", "oculto.pdf"],
    ["", "document.pdf"],
  ])("turns %j into %j", (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected);
  });
});

async function readEvents(
  response: Response,
): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
