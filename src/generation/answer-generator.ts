import type { AnswerStreamEvent, Citation, RetrievedChunk } from "../types.js";
import type { ChatModel } from "./chat-model.js";
import { buildMessages, isNoAnswer, NO_ANSWER } from "./prompt.js";

/** Streams answer text and citations derived from retrieved chunk metadata. */
export async function* generateAnswer(
  question: string,
  chunks: readonly RetrievedChunk[],
  chatModel: ChatModel,
): AsyncIterable<AnswerStreamEvent> {
  if (chunks.length === 0) {
    yield { type: "text_delta", text: NO_ANSWER };
    yield { type: "citations", citations: [] };
    return;
  }

  let answer = "";
  for await (const text of chatModel.stream(buildMessages(question, chunks))) {
    answer += text;
    yield { type: "text_delta", text };
  }

  yield {
    type: "citations",
    citations: isNoAnswer(answer) ? [] : citationsFrom(chunks, answer),
  };
}

/**
 * Lists each retrieved page once, in retrieval order. When the answer cites
 * some of the retrieved pages as [p. N], only those are kept; pages the model
 * mentions that were not retrieved are ignored.
 */
function citationsFrom(
  chunks: readonly RetrievedChunk[],
  answer: string,
): Citation[] {
  const retrieved = uniquePages(chunks);
  const citedPages = new Set(
    [...answer.matchAll(/\[p\.\s*(\d+)\]/gu)].map((match) => Number(match[1])),
  );
  const cited = retrieved.filter((citation) =>
    citedPages.has(citation.pageNumber),
  );
  return cited.length > 0 ? cited : retrieved;
}

function uniquePages(chunks: readonly RetrievedChunk[]): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const { documentId, pageNumber } of chunks) {
    const key = `${documentId}:${pageNumber}`;
    if (!seen.has(key)) {
      seen.add(key);
      citations.push({ documentId, pageNumber });
    }
  }
  return citations;
}
