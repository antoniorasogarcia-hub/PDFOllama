import { isNoAnswer } from "../src/generation/prompt.js";
import type { AnswerableCase, EvalCase, ExpectedFact } from "./dataset.js";

/** A page of a document, used for retrieved chunks and citations. */
export interface PageRef {
  fileName: string;
  pageNumber: number;
}

export interface RetrievalScore {
  /** Every expected page was among the retrieved chunks. */
  hit: boolean;
  /** 1-based position of the first expected page, or null if none. */
  rank: number | null;
}

export interface AnswerScore {
  correct: boolean;
  /** The model answered "No lo sé". */
  refused: boolean;
  /** Facts the answer should contain but does not. */
  missingFacts: string[];
  /** Citations include an expected page (answerable cases only). */
  citesExpectedPage: boolean;
}

export interface CaseResult {
  evalCase: EvalCase;
  retrieved: PageRef[];
  retrieval: RetrievalScore | null;
  answer: string | null;
  citations: PageRef[];
  answerScore: AnswerScore | null;
  latencyMs: number | null;
}

export interface Summary {
  retrieval: { hits: number; total: number; meanReciprocalRank: number };
  answers: {
    correct: number;
    total: number;
    citesExpectedPage: number;
    falseRefusals: number;
  } | null;
  traps: { passed: number; total: number } | null;
  latency: { meanMs: number; maxMs: number } | null;
}

/**
 * Normalizes text so facts match regardless of case, accents, currency
 * symbols, or Spanish number formatting ("1.200" → "1200", "0,26" → "0.26").
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("€", " euros ")
    .replace(/(\d)\.(\d{3})(?!\d)/gu, "$1$2")
    .replace(/(\d),(\d)/gu, "$1.$2")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Checks a fact as a whole word or number, so "24" does not match "124". */
export function containsFact(text: string, fact: ExpectedFact): boolean {
  const normalizedText = normalizeForMatch(text);
  const alternatives = typeof fact === "string" ? [fact] : fact;
  return alternatives.some((alternative) => {
    const escaped = normalizeForMatch(alternative).replace(
      /[.*+?^${}()|[\]\\]/gu,
      "\\$&",
    );
    return new RegExp(
      `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
      "u",
    ).test(normalizedText);
  });
}

/** Scores whether retrieval found the pages that contain the answer. */
export function scoreRetrieval(
  evalCase: AnswerableCase,
  retrieved: readonly PageRef[],
): RetrievalScore {
  const isExpected = (ref: PageRef) =>
    ref.fileName === evalCase.document &&
    evalCase.expectedPages.includes(ref.pageNumber);

  const index = retrieved.findIndex(isExpected);
  const hit = evalCase.expectedPages.every((page) =>
    retrieved.some(
      (ref) => ref.fileName === evalCase.document && ref.pageNumber === page,
    ),
  );
  return { hit, rank: index === -1 ? null : index + 1 };
}

/** Scores an answer with deterministic checks; no model acts as a judge. */
export function scoreAnswer(
  evalCase: EvalCase,
  answer: string,
  citations: readonly PageRef[],
): AnswerScore {
  const refused = isNoAnswer(answer);
  if (evalCase.type === "trap") {
    return {
      correct: refused && citations.length === 0,
      refused,
      missingFacts: [],
      citesExpectedPage: false,
    };
  }

  const missingFacts = evalCase.expectedFacts
    .filter((fact) => !containsFact(answer, fact))
    .map((fact) => (typeof fact === "string" ? fact : fact.join(" | ")));
  return {
    correct: !refused && missingFacts.length === 0,
    refused,
    missingFacts,
    citesExpectedPage: citations.some(
      (citation) =>
        citation.fileName === evalCase.document &&
        evalCase.expectedPages.includes(citation.pageNumber),
    ),
  };
}

/** Aggregates case results into the metrics of the pull request template. */
export function summarize(results: readonly CaseResult[]): Summary {
  const answerable = results.filter(
    (result) => result.evalCase.type === "answerable",
  );
  const retrievalScores = answerable.flatMap((result) =>
    result.retrieval ? [result.retrieval] : [],
  );
  const answered = results.filter((result) => result.answerScore !== null);
  const answeredAnswerable = answered.filter(
    (result) => result.evalCase.type === "answerable",
  );
  const answeredTraps = answered.filter(
    (result) => result.evalCase.type === "trap",
  );
  const latencies = answered.flatMap((result) =>
    result.latencyMs === null ? [] : [result.latencyMs],
  );

  return {
    retrieval: {
      hits: retrievalScores.filter((score) => score.hit).length,
      total: retrievalScores.length,
      meanReciprocalRank: mean(
        retrievalScores.map((score) => (score.rank ? 1 / score.rank : 0)),
      ),
    },
    answers:
      answeredAnswerable.length === 0
        ? null
        : {
            correct: count(answeredAnswerable, (score) => score.correct),
            total: answeredAnswerable.length,
            citesExpectedPage: count(
              answeredAnswerable,
              (score) => score.citesExpectedPage,
            ),
            falseRefusals: count(answeredAnswerable, (score) => score.refused),
          },
    traps:
      answeredTraps.length === 0
        ? null
        : {
            passed: count(answeredTraps, (score) => score.correct),
            total: answeredTraps.length,
          },
    latency:
      latencies.length === 0
        ? null
        : { meanMs: mean(latencies), maxMs: Math.max(...latencies) },
  };
}

function count(
  results: readonly CaseResult[],
  predicate: (score: AnswerScore) => boolean,
): number {
  return results.filter(
    (result) => result.answerScore && predicate(result.answerScore),
  ).length;
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}
