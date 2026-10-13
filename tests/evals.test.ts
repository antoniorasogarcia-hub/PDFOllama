import { describe, expect, it } from "vitest";
import { loadDataset, parseDataset } from "../evals/dataset.js";
import { renderReport } from "../evals/report.js";
import {
  type CaseResult,
  containsFact,
  extractNumbers,
  normalizeForMatch,
  scoreAnswer,
  scoreRetrieval,
  scoreSummary,
  summarize,
} from "../evals/score.js";
import { NO_ANSWER } from "../src/generation/prompt.js";
import { sampleDocuments } from "./fixtures/sample-document.js";

const vacationsCase = {
  id: "vacaciones",
  question: "¿Cuántos días de vacaciones?",
  type: "answerable",
  document: "manual.pdf",
  expectedPages: [2],
  expectedFacts: ["24"],
} as const;
const trapCase = {
  id: "trampa",
  question: "¿Director?",
  type: "trap",
} as const;

describe("evaluation dataset", () => {
  it("is valid and only uses fixture documents", async () => {
    const dataset = await loadDataset();

    expect(dataset.cases.length).toBeGreaterThanOrEqual(20);
    for (const fileName of dataset.documents) {
      expect(sampleDocuments[fileName]).toBeDefined();
    }
  });

  it("has every expected fact on the expected pages of its document", async () => {
    const dataset = await loadDataset();

    for (const evalCase of dataset.cases) {
      if (evalCase.type !== "answerable") {
        continue;
      }
      const pages = sampleDocuments[evalCase.document] ?? [];
      const expectedText = evalCase.expectedPages
        .map((page) => pages[page - 1] ?? "")
        .join("\n");
      for (const fact of evalCase.expectedFacts) {
        expect(
          containsFact(expectedText, fact),
          `${evalCase.id}: ${JSON.stringify(fact)}`,
        ).toBe(true);
      }
    }
  });

  it("has every expected summary topic in its document", async () => {
    const dataset = await loadDataset();

    expect(dataset.summaries.length).toBeGreaterThan(0);
    for (const summaryCase of dataset.summaries) {
      const text = (sampleDocuments[summaryCase.document] ?? []).join("\n");
      for (const topic of summaryCase.expectedTopics) {
        expect(
          containsFact(text, topic),
          `${summaryCase.id}: ${JSON.stringify(topic)}`,
        ).toBe(true);
      }
    }
  });

  it("rejects malformed datasets", () => {
    const withCases = (cases: unknown[]) => ({ documents: ["a.pdf"], cases });

    expect(() => parseDataset({ documents: [], cases: [] })).toThrow(
      "non-empty documents",
    );
    expect(() =>
      parseDataset(withCases([trapCase, { ...trapCase, question: "Otra" }])),
    ).toThrow('Duplicate case id "trampa"');
    expect(() => parseDataset(withCases([vacationsCase]))).toThrow(
      "must name one of the dataset documents",
    );
    expect(() =>
      parseDataset(
        withCases([
          { ...vacationsCase, document: "a.pdf", expectedPages: [0] },
        ]),
      ),
    ).toThrow("needs expectedPages");
    expect(() =>
      parseDataset(withCases([{ ...trapCase, type: "otro" }])),
    ).toThrow('unknown type "otro"');
  });
});

describe("normalizeForMatch", () => {
  it.each([
    ["Días de VACACIONES", "dias de vacaciones"],
    ["1.200 euros", "1200 euros"],
    ["0,26 €/km", "0.26 euros /km"],
    ["35€", "35 euros"],
    ["  a\n  b ", "a b"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeForMatch(input)).toBe(expected);
  });
});

describe("containsFact", () => {
  it("matches facts regardless of accents and number formatting", () => {
    expect(containsFact("Tienes 1.200 € al año.", "1200")).toBe(true);
    expect(containsFact("Se pagan 0,26 euros.", "0.26")).toBe(true);
    expect(containsFact("Dura seis meses.", ["6 meses", "seis meses"])).toBe(
      true,
    );
    expect(containsFact("Se fundó en ZARAGOZA.", "zaragoza")).toBe(true);
  });

  it("does not match part of another number or word", () => {
    expect(containsFact("Hay 124 empleados.", "24")).toBe(false);
    expect(containsFact("En 2014.", "14")).toBe(false);
    expect(containsFact("Los martesanos.", "martes")).toBe(false);
  });
});

describe("scoreRetrieval", () => {
  it("reports a hit and the rank of the first expected page", () => {
    expect(
      scoreRetrieval(vacationsCase, [
        { fileName: "manual.pdf", pageNumber: 4 },
        { fileName: "manual.pdf", pageNumber: 2 },
      ]),
    ).toEqual({ hit: true, rank: 2 });
  });

  it("ignores the same page number in another document", () => {
    expect(
      scoreRetrieval(vacationsCase, [{ fileName: "otro.pdf", pageNumber: 2 }]),
    ).toEqual({ hit: false, rank: null });
  });

  it("needs every expected page for a hit", () => {
    const twoPages = { ...vacationsCase, expectedPages: [2, 7] };

    expect(
      scoreRetrieval(twoPages, [{ fileName: "manual.pdf", pageNumber: 7 }]),
    ).toEqual({ hit: false, rank: 1 });
  });
});

describe("scoreAnswer", () => {
  const page2 = [{ fileName: "manual.pdf", pageNumber: 2 }];

  it("accepts an answer with every fact and the expected citation", () => {
    expect(scoreAnswer(vacationsCase, "Tienes 24 días [p. 2].", page2)).toEqual(
      {
        correct: true,
        refused: false,
        missingFacts: [],
        citesExpectedPage: true,
      },
    );
  });

  it("reports missing facts and false refusals", () => {
    expect(scoreAnswer(vacationsCase, "Tienes 22 días.", [])).toMatchObject({
      correct: false,
      missingFacts: ["24"],
      citesExpectedPage: false,
    });
    expect(scoreAnswer(vacationsCase, NO_ANSWER, [])).toMatchObject({
      correct: false,
      refused: true,
    });
  });

  it("passes a trap only with a refusal and no citations", () => {
    expect(scoreAnswer(trapCase, NO_ANSWER, []).correct).toBe(true);
    expect(scoreAnswer(trapCase, "Es Ana García.", page2).correct).toBe(false);
  });
});

describe("summarize and renderReport", () => {
  const results: CaseResult[] = [
    result(
      vacationsCase,
      { hit: true, rank: 1 },
      "Tienes 24 días [p. 2].",
      1000,
    ),
    result(
      { ...vacationsCase, id: "otra" },
      { hit: false, rank: null },
      NO_ANSWER,
      3000,
    ),
    result(trapCase, null, NO_ANSWER, 2000),
  ];

  it("aggregates the pull request template metrics", () => {
    expect(summarize(results)).toEqual({
      retrieval: { hits: 1, total: 2, meanReciprocalRank: 0.5 },
      answers: { correct: 1, total: 2, citesExpectedPage: 1, falseRefusals: 1 },
      traps: { passed: 1, total: 1 },
      latency: { meanMs: 2000, maxMs: 3000 },
    });
  });

  it("renders the metrics, one row per case, and a manual review sample", () => {
    const report = renderReport(
      {
        label: "baseline",
        startedAt: new Date("2026-10-13T12:00:00Z"),
        retrievalOnly: false,
        chatModel: "llama3.2:3b",
        embeddingModel: "bge-m3",
        chunkSize: 450,
        chunkOverlap: 75,
        topK: 3,
      },
      results,
      summarize(results),
      (items, size) => items.slice(0, size),
    );

    expect(report).toContain(
      "| Acierto de recuperación (fragmento correcto en los k) | 1/2 (50 %) |",
    );
    expect(report).toContain("| Respuestas correctas | 1/2 (50 %) |");
    expect(report).toContain(
      '| Preguntas trampa respondidas con "no lo sé" | 1/1 (100 %) |',
    );
    expect(report).toContain(
      '| otra | con respuesta | ❌ no encontrada | ❌ dijo "no lo sé" | 3.0 s |',
    );
    expect(report).toContain("### vacaciones");
  });

  function result(
    evalCase: CaseResult["evalCase"],
    retrieval: CaseResult["retrieval"],
    answer: string,
    latencyMs: number,
  ): CaseResult {
    const citations =
      answer === NO_ANSWER ? [] : [{ fileName: "manual.pdf", pageNumber: 2 }];
    return {
      evalCase,
      retrieved: citations,
      retrieval,
      answer,
      citations,
      answerScore: scoreAnswer(evalCase, answer, citations),
      latencyMs,
    };
  }
});

describe("summary scoring", () => {
  const summaryCase = {
    id: "resumen",
    document: "manual.pdf",
    expectedTopics: [["vacaciones"], ["teletrabajo", "remoto"]],
  };
  const documentText =
    "Hay 24 días de vacaciones. Se teletrabaja 3 días. Formación: 1.200 euros.";

  it("extracts numbers but not page references", () => {
    expect(extractNumbers("Tienes 24 días [p. 2] y 1.200 € [p. 4-5].")).toEqual(
      ["24", "1200"],
    );
    expect(extractNumbers("De 8:30 a 17:30, 0,26 euros/km.")).toEqual([
      "8:30",
      "17:30",
      "0.26",
    ]);
  });

  it("passes a summary that covers every topic with real figures", () => {
    expect(
      scoreSummary(
        summaryCase,
        "Hay 24 días de vacaciones [p. 2] y trabajo en remoto 3 días [p. 3].",
        documentText,
      ),
    ).toEqual({ missingTopics: [], unsupportedNumbers: [], passed: true });
  });

  it("reports missing topics and invented figures", () => {
    expect(
      scoreSummary(
        summaryCase,
        "Hay 30 días de vacaciones [p. 2].",
        documentText,
      ),
    ).toEqual({
      missingTopics: ["teletrabajo | remoto"],
      unsupportedNumbers: ["30"],
      passed: false,
    });
  });

  it("rejects summary cases for unknown documents", () => {
    expect(() =>
      parseDataset({
        documents: ["a.pdf"],
        cases: [trapCase],
        summaries: [{ ...summaryCase, document: "b.pdf" }],
      }),
    ).toThrow('Summary "resumen" must name one of the dataset documents.');
  });
});
