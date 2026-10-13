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

export interface EvalDataset {
  /** Fixture PDFs (in tests/fixtures) to ingest before running the cases. */
  documents: readonly string[];
  cases: readonly EvalCase[];
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
  const { documents, cases } = (value ?? {}) as Record<string, unknown>;
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
  return { documents, cases: parsed };
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
