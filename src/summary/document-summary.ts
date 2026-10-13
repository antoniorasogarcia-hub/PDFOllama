import type { AppConfig } from "../config.js";
import type { ChatModel } from "../generation/chat-model.js";
import type { VectorStore } from "../store/vector-store.js";
import {
  type SummaryEvent,
  summarizeChunks,
  summaryInputBudget,
} from "./summarizer.js";
import type { SummaryCache } from "./summary-cache.js";

export interface SummaryDependencies {
  store: VectorStore & SummaryCache;
  chatModel: ChatModel;
  config: Pick<AppConfig, "models" | "generation">;
}

export type DocumentSummaryEvent =
  | SummaryEvent
  /** Ends the stream; cached is true when no model call was needed. */
  | { type: "done"; cached: boolean };

/**
 * Streams the summary of a stored document. A summary made earlier with the
 * same chat model is returned from the cache unless refresh is true.
 */
export async function* summarizeDocument(
  documentId: string,
  { store, chatModel, config }: SummaryDependencies,
  { refresh = false }: { refresh?: boolean } = {},
): AsyncIterable<DocumentSummaryEvent> {
  if (!refresh) {
    const cached = await store.findSummary(documentId, config.models.chat);
    if (cached !== undefined) {
      yield { type: "text_delta", text: cached };
      yield { type: "done", cached: true };
      return;
    }
  }

  const chunks = await store.listChunks(documentId);
  let summary = "";
  for await (const event of summarizeChunks(
    chunks,
    chatModel,
    summaryInputBudget(config.generation.contextWindow),
  )) {
    if (event.type === "text_delta") {
      summary += event.text;
    }
    yield event;
  }

  if (summary.trim() !== "") {
    await store.saveSummary(documentId, config.models.chat, summary.trim());
  }
  yield { type: "done", cached: false };
}
