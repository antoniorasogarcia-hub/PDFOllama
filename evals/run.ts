import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { OllamaEmbedder } from "../src/embeddings/ollama-embedder.js";
import { generateAnswer } from "../src/generation/answer-generator.js";
import { OllamaChatModel } from "../src/generation/ollama-chat-model.js";
import { indexPdf } from "../src/ingest/index-document.js";
import { retrieveRelevantChunks } from "../src/retrieval/retrieval.js";
import { SqliteVectorStore } from "../src/store/sqlite-vector-store.js";
import {
  summarizeChunks,
  summaryInputBudget,
} from "../src/summary/summarizer.js";
import type { Citation, TextChunk } from "../src/types.js";
import { loadDataset } from "./dataset.js";
import { type RunInfo, renderReport, renderSummaryReport } from "./report.js";
import {
  type CaseResult,
  type PageRef,
  type SummaryResult,
  scoreAnswer,
  scoreRetrieval,
  scoreSummary,
  summarize,
} from "./score.js";

const FIXTURES_DIRECTORY = new URL("../tests/fixtures/", import.meta.url);
const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);

const { values } = parseArgs({
  options: {
    "retrieval-only": { type: "boolean", default: false },
    summaries: { type: "boolean", default: false },
    label: { type: "string", default: "run" },
  },
});
const retrievalOnly = values["retrieval-only"];
const summariesOnly = values.summaries;
const label = values.label.replace(/[^\p{L}\p{N}_-]+/gu, "-");

const config = loadConfig();
const dataset = await loadDataset();
const startedAt = new Date();

// A fresh database per run, so chunking or model changes always take effect.
const databaseFile = `${config.paths.dataDirectory}/evals.db`;
await rm(databaseFile, { force: true });
const store = new SqliteVectorStore(databaseFile);
const embedder = new OllamaEmbedder({
  ...config.ollama,
  model: config.models.embedding,
});
const chatModel = new OllamaChatModel({
  ...config.ollama,
  ...config.generation,
  model: config.models.chat,
});

try {
  const fileNames = new Map<string, string>();
  for (const fileName of dataset.documents) {
    const pdfPath = fileURLToPath(new URL(fileName, FIXTURES_DIRECTORY));
    const { document } = await indexPdf(pdfPath, { embedder, store, config });
    fileNames.set(document.id, fileName);
    console.log(`Indexed ${fileName} (${document.chunkCount} chunks)`);
  }
  const toPageRef = (ref: TextChunk | Citation): PageRef => ({
    fileName: fileNames.get(ref.documentId) ?? ref.documentId,
    pageNumber: ref.pageNumber,
  });

  if (summariesOnly) {
    await runSummaryCases(fileNames);
  } else {
    await runQuestionCases(toPageRef);
  }
} finally {
  await store.close();
}

function progressLine(
  position: number,
  total: number,
  result: CaseResult,
): string {
  const retrieval = result.retrieval
    ? `retrieval ${result.retrieval.hit ? "ok" : "MISS"}`
    : "trap";
  const answer = result.answerScore
    ? ` · answer ${result.answerScore.correct ? "ok" : "FAIL"} · ${((result.latencyMs ?? 0) / 1000).toFixed(1)} s`
    : "";
  return `[${position}/${total}] ${result.evalCase.id}: ${retrieval}${answer}`;
}

async function runQuestionCases(
  toPageRef: (ref: TextChunk | Citation) => PageRef,
): Promise<void> {
  const results: CaseResult[] = [];
  for (const [index, evalCase] of dataset.cases.entries()) {
    const caseStartedAt = Date.now();
    const chunks = await retrieveRelevantChunks(
      evalCase.question,
      embedder,
      store,
      config.retrieval.topK,
    );
    const retrieved = chunks.map(toPageRef);
    const result: CaseResult = {
      evalCase,
      retrieved,
      retrieval:
        evalCase.type === "answerable"
          ? scoreRetrieval(evalCase, retrieved)
          : null,
      answer: null,
      citations: [],
      answerScore: null,
      latencyMs: null,
    };

    if (!retrievalOnly) {
      let answer = "";
      let citations: PageRef[] = [];
      for await (const event of generateAnswer(
        evalCase.question,
        chunks,
        chatModel,
      )) {
        if (event.type === "text_delta") {
          answer += event.text;
        } else {
          citations = event.citations.map(toPageRef);
        }
      }
      result.answer = answer;
      result.citations = citations;
      result.answerScore = scoreAnswer(evalCase, answer, citations);
      result.latencyMs = Date.now() - caseStartedAt;
    }

    results.push(result);
    console.log(progressLine(index + 1, dataset.cases.length, result));
  }

  const summary = summarize(results);
  const report = renderReport(runInfo(), results, summary);
  const reportUrl = await writeResults("", report, { summary, results });

  console.log(`\n${report.split("## Casos")[0]?.trim()}`);
  console.log(`\nReport written to ${fileURLToPath(reportUrl)}`);
}

/** Summarizes each dataset document and checks topics and figures. */
async function runSummaryCases(fileNames: Map<string, string>): Promise<void> {
  const documentIds = new Map(
    [...fileNames].map(([id, fileName]) => [fileName, id]),
  );
  const results: SummaryResult[] = [];
  for (const [index, summaryCase] of dataset.summaries.entries()) {
    const caseStartedAt = Date.now();
    const chunks = await store.listChunks(
      documentIds.get(summaryCase.document) ?? "",
    );
    let summary = "";
    for await (const event of summarizeChunks(
      chunks,
      chatModel,
      summaryInputBudget(config.generation.contextWindow),
    )) {
      if (event.type === "text_delta") {
        summary += event.text;
      }
    }
    const documentText = chunks.map((chunk) => chunk.text).join("\n");
    const result: SummaryResult = {
      summaryCase,
      summary,
      score: scoreSummary(summaryCase, summary, documentText),
      latencyMs: Date.now() - caseStartedAt,
    };
    results.push(result);
    console.log(
      `[${index + 1}/${dataset.summaries.length}] ${summaryCase.id}: ${result.score.passed ? "ok" : "FAIL"} · ${(result.latencyMs / 1000).toFixed(1)} s`,
    );
  }

  const report = renderSummaryReport(runInfo(), results);
  const reportUrl = await writeResults("summaries", report, { results });
  console.log(
    `\n${report.split(`\n## ${dataset.summaries[0]?.document}`)[0]?.trim()}`,
  );
  console.log(`\nReport written to ${fileURLToPath(reportUrl)}`);
}

function runInfo(): RunInfo {
  return {
    label,
    startedAt,
    retrievalOnly,
    chatModel: config.models.chat,
    embeddingModel: config.models.embedding,
    chunkSize: config.chunking.size,
    chunkOverlap: config.chunking.overlap,
    topK: config.retrieval.topK,
  };
}

/** Writes the Markdown report and the raw JSON results; returns the report URL. */
async function writeResults(
  suffix: string,
  report: string,
  data: unknown,
): Promise<URL> {
  await mkdir(RESULTS_DIRECTORY, { recursive: true });
  const baseName = `${startedAt.toISOString().slice(0, 16).replace(":", "")}-${label}${suffix ? `-${suffix}` : ""}`;
  const reportUrl = new URL(`${baseName}.md`, RESULTS_DIRECTORY);
  await writeFile(reportUrl, report);
  await writeFile(
    new URL(`${baseName}.json`, RESULTS_DIRECTORY),
    `${JSON.stringify(data, null, 2)}\n`,
  );
  return reportUrl;
}
