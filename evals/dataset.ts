import { readFile } from "node:fs/promises";

/** A fact the answer must contain; an array lists accepted alternatives. */
export type ExpectedFact = string | readonly string[];

export interface AnswerableCase {
  id: string;
  question: string;
  type: "answerable";
  /** File name of the document that contains the answer. */
  document: string;
  expectedPages: readonly number[];
  expectedFacts: readonly ExpectedFact[];
}

/** A question whose answer is not in any document: expect "No lo sé". */
export interface TrapCase {
  id: string;
  question: string;
  type: "trap";
}

export type EvalCase = AnswerableCase | TrapCase;

/** A document to summarize, with the topics its summary must mention. */
export interface SummaryCase {
  id: string;
  document: string;
  /** Each topic lists accepted words; the summary must contain one of them. */
  expectedTopics: readonly ExpectedFact[];
}

export interface EvalDataset {
  /** Fixture PDFs (in tests/fixtures) to ingest before running the cases. */
  documents: readonly string[];
  cases: readonly EvalCase[];
  summaries: readonly SummaryCase[];
}

export const DATASET_URL = new URL("./dataset.json", import.meta.url);

/** Reads and validates the evaluation dataset. */
export async function loadDataset(
  url: URL = DATASET_URL,
): Promise<EvalDataset> {
  return parseDataset(JSON.parse(await readFile(url, "utf8")));
}

/** Validates the dataset shape so a typo fails loudly instead of skewing scores. */
export function parseDataset(value: unknown): EvalDataset {
  const {
    documents,
    cases,
    summaries = [],
  } = (value ?? {}) as Record<string, unknown>;
  if (!isStringArray(documents) || documents.length === 0) {
    throw new Error("Dataset needs a non-empty documents array.");
  }
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("Dataset needs a non-empty cases array.");
  }

  const ids = new Set<string>();
  const parsed = cases.map((item: unknown, index): EvalCase => {
    const evalCase = parseCase(item, index, documents);
    if (ids.has(evalCase.id)) {
      throw new Error(`Duplicate case id "${evalCase.id}".`);
    }
    ids.add(evalCase.id);
    return evalCase;
  });
  if (!Array.isArray(summaries)) {
    throw new Error("Dataset summaries must be an array.");
  }
  const parsedSummaries = summaries.map((item: unknown): SummaryCase => {
    const summary = parseSummaryCase(item, documents);
    if (ids.has(summary.id)) {
      throw new Error(`Duplicate case id "${summary.id}".`);
    }
    ids.add(summary.id);
    return summary;
  });
  return { documents, cases: parsed, summaries: parsedSummaries };
}

function parseSummaryCase(
  item: unknown,
  documents: readonly string[],
): SummaryCase {
  const { id, document, expectedTopics } = (item ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof id !== "string" || id === "") {
    throw new Error("Every summary case needs an id.");
  }
  if (typeof document !== "string" || !documents.includes(document)) {
    throw new Error(`Summary "${id}" must name one of the dataset documents.`);
  }
  if (
    !Array.isArray(expectedTopics) ||
    expectedTopics.length === 0 ||
    !expectedTopics.every(
      (topic) =>
        (typeof topic === "string" && topic !== "") ||
        (isStringArray(topic) && topic.length > 0),
    )
  ) {
    throw new Error(`Summary "${id}" needs expectedTopics.`);
  }
  return { id, document, expectedTopics: expectedTopics as ExpectedFact[] };
}

function parseCase(
  item: unknown,
  index: number,
  documents: readonly string[],
): EvalCase {
  const fields = (item ?? {}) as Record<string, unknown>;
  const { id, question, type } = fields;
  const where = `Case #${index + 1}`;
  if (typeof id !== "string" || id === "") {
    throw new Error(`${where} needs an id.`);
  }
  if (typeof question !== "string" || question.trim() === "") {
    throw new Error(`Case "${id}" needs a question.`);
  }
  if (type === "trap") {
    return { id, question, type };
  }
  if (type !== "answerable") {
    throw new Error(`Case "${id}" has an unknown type "${String(type)}".`);
  }

  const { document, expectedPages, expectedFacts } = fields;
  if (typeof document !== "string" || !documents.includes(document)) {
    throw new Error(`Case "${id}" must name one of the dataset documents.`);
  }
  if (
    !Array.isArray(expectedPages) ||
    expectedPages.length === 0 ||
    !expectedPages.every((page) => Number.isInteger(page) && page > 0)
  ) {
    throw new Error(`Case "${id}" needs expectedPages with page numbers.`);
  }
  if (
    !Array.isArray(expectedFacts) ||
    expectedFacts.length === 0 ||
    !expectedFacts.every(
      (fact) =>
        (typeof fact === "string" && fact !== "") ||
        (isStringArray(fact) && fact.length > 0),
    )
  ) {
    throw new Error(`Case "${id}" needs expectedFacts.`);
  }
  return {
    id,
    question,
    type,
    document,
    expectedPages: expectedPages as number[],
    expectedFacts: expectedFacts as ExpectedFact[],
  };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
