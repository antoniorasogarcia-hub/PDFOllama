import type { RetrievedChunk } from "../types.js";
import type { ChatMessage } from "./chat-model.js";

/** The exact reply the model must give when the context lacks the answer. */
export const NO_ANSWER = "No lo sé: el documento no contiene esa información.";

/*
 * The prompt is in Spanish because most documents and questions are Spanish,
 * and small models answer more consistently in the language of their prompt.
 */
const SYSTEM_PROMPT = `Eres un asistente que responde preguntas sobre documentos PDF.
Reglas:
1. Responde únicamente con la información de los fragmentos del documento que aparecen en el mensaje del usuario. No uses conocimientos propios ni inventes datos.
2. Después de cada dato, indica su página entre corchetes, por ejemplo [p. 4].
3. Si los fragmentos no contienen la respuesta, responde exactamente "${NO_ANSWER}" y nada más.
4. Responde de forma breve y en el mismo idioma que la pregunta.`;

/** Builds the chat messages that ground the model in the retrieved chunks. */
export function buildMessages(
  question: string,
  chunks: readonly RetrievedChunk[],
): ChatMessage[] {
  const context = chunks
    .map((chunk) => `[p. ${chunk.pageNumber}]\n${chunk.text}`)
    .join("\n\n");

  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Fragmentos del documento:\n\n${context}\n\nPregunta: ${question.trim()}`,
    },
  ];
}

/** Detects the "I don't know" reply, tolerating small variations. */
export function isNoAnswer(text: string): boolean {
  const normalized = text
    .trim()
    .toLocaleLowerCase("es")
    .replace(/^["'«“]+/u, "");
  return ["no lo sé", "no sé", "i don't know"].some((prefix) =>
    normalized.startsWith(prefix),
  );
}
