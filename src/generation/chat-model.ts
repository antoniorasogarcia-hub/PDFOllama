export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatModel {
  /** Streams generated text for a sequence of chat messages. */
  stream(messages: readonly ChatMessage[]): AsyncIterable<string>;
}
