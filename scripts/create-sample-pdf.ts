import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPdf } from "../tests/fixtures/pdf-builder.js";
import { sampleDocuments } from "../tests/fixtures/sample-document.js";

const outputDirectory = process.argv[2] ?? "tests/fixtures";

await mkdir(outputDirectory, { recursive: true });
for (const [fileName, pages] of Object.entries(sampleDocuments)) {
  const outputPath = join(outputDirectory, fileName);
  await writeFile(outputPath, createPdf(pages));
  console.log(`Sample PDF written to ${outputPath}`);
}
