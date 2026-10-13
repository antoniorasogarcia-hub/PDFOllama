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
import type { Citation, TextChunk } from "../src/types.js";
import { loadDataset } from "./dataset.js";
import { renderReport } from "./report.js";
import {
  type CaseResult,
  type PageRef,
  scoreAnswer,
  scoreRetrieval,
  summarize,
} from "./score.js";

const FIXTURES_DIRECTORY = new URL("../tests/fixtures/", import.meta.url);
const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);

const { values } = parseArgs({
  options: {
    "retrieval-only": { type: "boolean", default: false },
    label: { type: "string", default: "run" },
  },
});
const retrievalOnly = values["retrieval-only"];
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
  const report = renderReport(
    {
      label,
      startedAt,
      retrievalOnly,
      chatModel: config.models.chat,
      embeddingModel: config.models.embedding,
      chunkSize: config.chunking.size,
      chunkOverlap: config.chunking.overlap,
      topK: config.retrieval.topK,
    },
    results,
    summary,
  );

  await mkdir(RESULTS_DIRECTORY, { recursive: true });
  const baseName = `${startedAt.toISOString().slice(0, 16).replace(":", "")}-${label}`;
  const reportUrl = new URL(`${baseName}.md`, RESULTS_DIRECTORY);
  await writeFile(reportUrl, report);
  await writeFile(
    new URL(`${baseName}.json`, RESULTS_DIRECTORY),
    `${JSON.stringify({ summary, results }, null, 2)}\n`,
  );

  console.log(`\n${report.split("## Casos")[0]?.trim()}`);
  console.log(`\nReport written to ${fileURLToPath(reportUrl)}`);
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
