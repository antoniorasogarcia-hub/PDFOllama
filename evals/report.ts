import type { CaseResult, PageRef, Summary } from "./score.js";

export interface RunInfo {
  label: string;
  startedAt: Date;
  retrievalOnly: boolean;
  chatModel: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
}

const MANUAL_REVIEW_SAMPLE_SIZE = 5;

/** Renders a run as Markdown, in Spanish like the pull request template. */
export function renderReport(
  info: RunInfo,
  results: readonly CaseResult[],
  summary: Summary,
  pickSample: (
    results: readonly CaseResult[],
    size: number,
  ) => CaseResult[] = randomSample,
): string {
  const lines = [
    `# Evals: ${info.label}`,
    "",
    `- Fecha: ${info.startedAt.toISOString()}`,
    `- Modo: ${info.retrievalOnly ? "solo recuperación" : "completo"}`,
    `- Modelo de chat: \`${info.chatModel}\` · embeddings: \`${info.embeddingModel}\``,
    `- Fragmentos: ${info.chunkSize} tokens, solapamiento ${info.chunkOverlap} · k = ${info.topK}`,
    "",
    "## Métricas",
    "",
    "| Métrica | Resultado |",
    "| --- | --- |",
    ...metricRows(summary),
    "",
    "## Casos",
    "",
    "| Caso | Tipo | Recuperación | Respuesta | Tiempo |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(caseRow),
  ];

  const sample = pickSample(
    results.filter((result) => result.answer !== null),
    MANUAL_REVIEW_SAMPLE_SIZE,
  );
  if (sample.length > 0) {
    lines.push(
      "",
      "## Revisión manual (muestra aleatoria)",
      "",
      "Comprueba que cada respuesta es fiel al documento, aunque haya pasado las comprobaciones automáticas.",
    );
    for (const result of sample) {
      lines.push(
        "",
        `### ${result.evalCase.id}`,
        "",
        `**Pregunta:** ${result.evalCase.question}`,
        "",
        `**Respuesta:** ${oneLine(result.answer ?? "")}`,
        "",
        `**Fuentes:** ${formatRefs(result.citations) || "ninguna"}`,
        "",
        "- [ ] Fiel al documento",
        "- [ ] Cita la página correcta",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function metricRows(summary: Summary): string[] {
  const { retrieval, answers, traps, latency } = summary;
  const rows = [
    `| Acierto de recuperación (fragmento correcto en los k) | ${ratio(retrieval.hits, retrieval.total)} |`,
  ];
  if (answers) {
    rows.push(
      `| Respuestas correctas | ${ratio(answers.correct, answers.total)} |`,
    );
  }
  if (traps) {
    rows.push(
      `| Preguntas trampa respondidas con "no lo sé" | ${ratio(traps.passed, traps.total)} |`,
    );
  }
  rows.push(
    `| MRR de recuperación | ${retrieval.meanReciprocalRank.toFixed(2)} |`,
  );
  if (answers) {
    rows.push(
      `| Citan la página esperada | ${ratio(answers.citesExpectedPage, answers.total)} |`,
      `| "No lo sé" con la respuesta en el documento | ${ratio(answers.falseRefusals, answers.total)} |`,
    );
  }
  if (latency) {
    rows.push(
      `| Tiempo por respuesta (media / máximo) | ${seconds(latency.meanMs)} / ${seconds(latency.maxMs)} |`,
    );
  }
  return rows;
}

function caseRow(result: CaseResult): string {
  const { evalCase, retrieval, answerScore } = result;
  const retrievalCell = retrieval
    ? `${retrieval.hit ? "✅" : "❌"} ${retrieval.rank ? `#${retrieval.rank}` : "no encontrada"}`
    : "—";

  let answerCell = "—";
  if (answerScore) {
    const detail = answerScore.correct
      ? ""
      : answerScore.refused
        ? ' dijo "no lo sé"'
        : evalCase.type === "trap"
          ? " respondió en vez de decir que no lo sabe"
          : ` falta: ${answerScore.missingFacts.join(", ")}`;
    answerCell = `${answerScore.correct ? "✅" : "❌"}${detail}`;
  }

  const time = result.latencyMs === null ? "—" : seconds(result.latencyMs);
  return `| ${evalCase.id} | ${evalCase.type === "trap" ? "trampa" : "con respuesta"} | ${retrievalCell} | ${escapeCell(answerCell)} | ${time} |`;
}

function randomSample(
  results: readonly CaseResult[],
  size: number,
): CaseResult[] {
  return [...results]
    .map((result) => ({ result, key: Math.random() }))
    .sort((a, b) => a.key - b.key)
    .slice(0, size)
    .map(({ result }) => result);
}

function formatRefs(refs: readonly PageRef[]): string {
  return refs.map((ref) => `${ref.fileName} p. ${ref.pageNumber}`).join(", ");
}

function ratio(part: number, total: number): string {
  return `${part}/${total} (${total === 0 ? 0 : Math.round((part / total) * 100)} %)`;
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}
