import type { IncomingMessage, ServerResponse } from "node:http";

/** An error with an HTTP status whose message can be shown to the user. */
export class HttpError extends Error {
  override readonly name = "HttpError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Reads the whole request body, failing with 413 when it exceeds maxBytes. */
export async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"]);
  if (declaredLength > maxBytes) {
    throw new HttpError(413, tooLargeMessage(maxBytes));
  }

  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of request) {
    length += (part as Buffer).length;
    if (length > maxBytes) {
      throw new HttpError(413, tooLargeMessage(maxBytes));
    }
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

/** Fails with 415 unless the request declares the expected content type. */
export function requireContentType(
  request: IncomingMessage,
  expected: string,
): void {
  const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
  if (contentType !== expected) {
    throw new HttpError(
      415,
      `Expected a request with content type ${expected}.`,
    );
  }
}

/** Sends a JSON response. */
export function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

/**
 * Starts a newline-delimited JSON stream and returns a function that writes
 * one event per line. Writes after the client disconnects are ignored.
 */
export function startEventStream(
  response: ServerResponse,
): (event: unknown) => void {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  return (event) => {
    if (!response.destroyed && !response.writableEnded) {
      response.write(`${JSON.stringify(event)}\n`);
    }
  };
}

function tooLargeMessage(maxBytes: number): string {
  return `The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit (PDF_OLLAMA_MAX_UPLOAD_MB).`;
}
