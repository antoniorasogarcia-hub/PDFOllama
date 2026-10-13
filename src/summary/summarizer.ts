import type { ChatMessage, ChatModel } from "../generation/chat-model.js";
import type { TextChunk } from "../types.js";

export type SummaryEvent =
  /** A section of the document was summarized (only for long documents). */
  | { type: "progress"; done: number; total: number }
  /** Streamed text of the final summary. */
  | { type: "text_delta"; text: string };

/**
 * Characters per token used to size summary input. It is lower than the
 * chunking estimate on purpose, to stay safely inside the context window.
 */
const CHARS_PER_TOKEN = 3;
/** Tokens kept free for the system prompt and the generated summary. */
const RESERVED_TOKENS = 1200;

const SECTION_PROMPT = `Resumes partes de un documento PDF.
Reglas:
1. Usa solo la información del texto. No añadas conocimientos propios ni inventes datos.
2. Escribe entre 3 y 6 puntos breves con las ideas y las cifras más importantes. Copia las cifras exactamente.
3. Cada parte del texto empieza con su página, por ejemplo [p. 4]. Termina cada punto con su página entre corchetes, por ejemplo [p. 4].
4. Escribe en el mismo idioma que el texto.`;

const FINAL_PROMPT = `Escribes el resumen de un documento PDF a partir de su texto o de los resúmenes de sus partes.
Reglas:
1. Usa solo esa información. No añadas conocimientos propios ni inventes datos. Copia las cifras exactamente.
2. Empieza con un párrafo breve que explique de qué trata el documento.
3. Después escribe "Puntos clave:" y una lista de entre 4 y 8 puntos con lo más importante de todo el documento, sin dejar fuera ninguna sección relevante.
4. Termina cada punto con sus páginas entre corchetes, por ejemplo [p. 4] o [p. 4-5].
5. Escribe en el mismo idioma que el documento.`;

interface Section {
  firstPage: number;
  lastPage: number;
  text: string;
}

/** Maximum characters of document text sent in one summary request. */
export function summaryInputBudget(contextWindow: number): number {
  return Math.max(1000, (contextWindow - RESERVED_TOKENS) * CHARS_PER_TOKEN);
}

/**
 * Summarizes a whole document. Short documents are summarized in one call.
 * Long ones are split into consecutive sections that fit the context window;
 * each section is summarized, and the section summaries are combined (in
 * several rounds if needed) into the final summary, which is streamed.
 */
export async function* summarizeChunks(
  chunks: readonly TextChunk[],
  chatModel: ChatModel,
  maxChars: number,
): AsyncIterable<SummaryEvent> {
  if (chunks.length === 0) {
    throw new Error("The document has no text to summarize.");
  }

  const sections = groupIntoSections(
    chunks.map((chunk) => ({
      firstPage: chunk.pageNumber,
      lastPage: chunk.pageNumber,
      text: `[p. ${chunk.pageNumber}]\n${chunk.text}`,
    })),
    maxChars,
  );
  const [onlySection] = sections;
  if (sections.length === 1 && onlySection !== undefined) {
    yield* streamFinal(
      `Texto del documento:\n\n${onlySection.text}`,
      chatModel,
    );
    return;
  }

  let summaries: Section[] = [];
  for (const [index, section] of sections.entries()) {
    summaries.push(await summarizeSection(section, chatModel));
    yield { type: "progress", done: index + 1, total: sections.length };
  }

  // Combine section summaries until they fit in a single final request.
  while (joinedLength(summaries) > maxChars) {
    const groups = groupIntoSections(summaries, maxChars);
    if (groups.length === summaries.length) {
      break;
    }
    summaries = [];
    for (const group of groups) {
      summaries.push(await summarizeSection(group, chatModel));
    }
  }

  yield* streamFinal(
    `Resúmenes de las partes del documento:\n\n${summaries.map((summary) => summary.text).join("\n\n")}`,
    chatModel,
  );
}

/** Groups consecutive sections so each group's text fits in maxChars. */
export function groupIntoSections(
  sections: readonly Section[],
  maxChars: number,
): Section[] {
  const groups: Section[] = [];
  let current: Section | undefined;
  for (const section of sections) {
    if (
      current !== undefined &&
      current.text.length + 2 + section.text.length <= maxChars
    ) {
      current = {
        firstPage: current.firstPage,
        lastPage: section.lastPage,
        text: `${current.text}\n\n${section.text}`,
      };
    } else {
      if (current !== undefined) {
        groups.push(current);
      }
      current = { ...section };
    }
  }
  if (current !== undefined) {
    groups.push(current);
  }
  return groups;
}

async function summarizeSection(
  section: Section,
  chatModel: ChatModel,
): Promise<Section> {
  const pages =
    section.firstPage === section.lastPage
      ? `página ${section.firstPage}`
      : `páginas ${section.firstPage}-${section.lastPage}`;
  const messages: ChatMessage[] = [
    { role: "system", content: SECTION_PROMPT },
    { role: "user", content: `Texto (${pages}):\n\n${section.text}` },
  ];

  let summary = "";
  for await (const text of chatModel.stream(messages)) {
    summary += text;
  }
  return {
    firstPage: section.firstPage,
    lastPage: section.lastPage,
    text: `Resumen de ${section.firstPage === section.lastPage ? "la" : "las"} ${pages}:\n${summary.trim()}`,
  };
}

async function* streamFinal(
  content: string,
  chatModel: ChatModel,
): AsyncIterable<SummaryEvent> {
  const messages: ChatMessage[] = [
    { role: "system", content: FINAL_PROMPT },
    { role: "user", content },
  ];
  for await (const text of chatModel.stream(messages)) {
    yield { type: "text_delta", text };
  }
}

function joinedLength(sections: readonly Section[]): number {
  return sections.reduce(
    (total, section) => total + section.text.length + 2,
    0,
  );
}
