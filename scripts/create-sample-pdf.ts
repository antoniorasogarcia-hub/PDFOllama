import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createPdf } from "../tests/fixtures/pdf-builder.js";
import { samplePages } from "../tests/fixtures/sample-document.js";

const outputPath = process.argv[2] ?? "tests/fixtures/manual-nebula.pdf";

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, createPdf(samplePages));
console.log(`Sample PDF written to ${outputPath}`);
