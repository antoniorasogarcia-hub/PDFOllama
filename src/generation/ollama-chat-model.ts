import type { AppConfig } from "../config.js";
import {
  createInactivityTimeout,
  isRecord,
  OllamaError,
  postToOllama,
  readLines,
  toOllamaError,
} from "../ollama/ollama-http.js";
import type { ChatMessage, ChatModel } from "./chat-model.js";

export type OllamaChatConfig = AppConfig["ollama"] &
  AppConfig["generation"] & { model: string };

export class OllamaChatModel implements ChatModel {
  /** Stores the settings for the Ollama chat adapter. */
  constructor(private readonly config: OllamaChatConfig) {}

  /**
   * Streams generated text from the configured Ollama chat model. The timeout
   * applies to inactivity, so long answers are fine while tokens keep coming.
   */
  async *stream(messages: readonly ChatMessage[]): AsyncIterable<string> {
    const timeout = createInactivityTimeout(this.config.timeoutMs);
    try {
      const response = await postToOllama(
        this.config,
        "/api/chat",
        {
          model: this.config.model,
          messages,
          stream: true,
          options: {
            temperature: this.config.temperature,
            num_ctx: this.config.contextWindow,
          },
        },
        timeout.signal,
      );
      if (response.body === null) {
        throw new OllamaError("Ollama returned an empty response.");
      }

      for await (const line of readLines(response.body)) {
        timeout.reset();
        const part = parseChatLine(line);
        if (part.text) {
          yield part.text;
        }
        if (part.done) {
          return;
        }
      }
      throw new OllamaError(
        "Ollama closed the stream before finishing the answer.",
      );
    } catch (error) {
      throw toOllamaError(error, this.config);
    } finally {
      timeout.clear();
    }
  }
}

function parseChatLine(line: string): { text: string; done: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new OllamaError(
      `Unexpected chat response from Ollama: ${line.slice(0, 200)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new OllamaError("Unexpected chat response from Ollama.");
  }
  if (typeof parsed.error === "string") {
    throw new OllamaError(`Ollama failed while generating: ${parsed.error}`);
  }

  const message = parsed.message;
  const text =
    isRecord(message) && typeof message.content === "string"
      ? message.content
      : "";
  return { text, done: parsed.done === true };
}
