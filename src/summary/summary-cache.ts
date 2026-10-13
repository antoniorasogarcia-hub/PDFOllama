/** Stores generated summaries so each document is summarized only once. */
export interface SummaryCache {
  /** Returns the summary made with this chat model, if any. */
  findSummary(
    documentId: string,
    chatModel: string,
  ): Promise<string | undefined>;
  /** Saves a summary; it is removed when its document is deleted or replaced. */
  saveSummary(
    documentId: string,
    chatModel: string,
    summary: string,
  ): Promise<void>;
}
