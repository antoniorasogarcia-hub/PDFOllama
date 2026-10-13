import type { AppConfig } from "../config.js";

export type OllamaConnection = AppConfig["ollama"];

/** An Ollama failure with a message that can be shown to the user. */
export class OllamaError extends Error {
  override readonly name = "OllamaError";
}

/** An abort signal that fires when no activity is reported within the timeout. */
export interface InactivityTimeout {
  signal: AbortSignal;
  /** Restarts the countdown, e.g. after receiving a streamed chunk. */
  reset(): void;
  clear(): void;
}

/** Creates a timeout that aborts a request after a period of inactivity. */
export function createInactivityTimeout(timeoutMs: number): InactivityTimeout {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const reset = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  reset();
  return { signal: controller.signal, reset, clear: () => clearTimeout(timer) };
}

/** Sends a JSON POST request to Ollama and fails with a helpful OllamaError. */
export async function postToOllama(
  connection: OllamaConnection,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${connection.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw toOllamaError(error, connection);
  }

  if (!response.ok) {
    throw new OllamaError(await describeErrorResponse(response));
  }
  return response;
}

/** Converts network and abort failures into an OllamaError. */
export function toOllamaError(
  error: unknown,
  connection: OllamaConnection,
): Error {
  if (error instanceof OllamaError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new OllamaError(
      `Ollama did not respond within ${connection.timeoutMs} ms. Increase PDF_OLLAMA_TIMEOUT_MS or use a smaller model.`,
    );
  }
  return new OllamaError(
    `Could not connect to Ollama at ${connection.baseUrl}. Is it running? Start it with "ollama serve".`,
  );
}

/** Reads a streamed response body as text lines (Ollama streams NDJSON). */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    yield* lines.filter((line) => line.trim() !== "");
  }
  if (buffer.trim() !== "") {
    yield buffer;
  }
}

async function describeErrorResponse(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  let detail = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.error === "string") {
      detail = parsed.error;
    }
  } catch {
    // Keep the raw body when it is not JSON.
  }

  const hint =
    response.status === 404 ? ' Download it with "ollama pull <model>".' : "";
  return `Ollama returned HTTP ${response.status}: ${detail || response.statusText}.${hint}`;
}

/** Narrows an unknown JSON value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
