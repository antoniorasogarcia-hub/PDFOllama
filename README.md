# PDFOllama
Upload a PDF, ask questions in natural language, and check every answer against the source: each response cites the pages it came from, and says "I don't know" when the document doesn't contain the answer. Runs entirely on your machine with Ollama, so it costs nothing to try.

## Requirements

- Node.js 24 or newer.
- [Ollama](https://ollama.com) running locally, with the models pulled:

```sh
ollama pull bge-m3        # embeddings (multilingual, good for Spanish)
ollama pull llama3.2:3b   # answers
```

## Web interface

```sh
npm ci
npm run web
```

Open <http://localhost:3000>, drag your PDFs onto the page, and ask questions once they are processed. Answers stream as they are generated and list the pages they come from. The server only listens on your machine (`127.0.0.1`), and uploaded PDFs are not stored: only their text chunks and embeddings are kept in the local database.

## Command line

```sh
npm run build

node dist/cli.js ingest tests/fixtures/manual-nebula.pdf   # index one or more PDFs
node dist/cli.js list                                      # indexed documents
node dist/cli.js search "precio del hotel"                 # inspect retrieved chunks and scores
node dist/cli.js ask "¿Cuántos días de vacaciones tengo?"
node dist/cli.js chat                                      # several questions in a row
node dist/cli.js remove manual-nebula.pdf
node dist/cli.js serve                                     # same as npm run web, from the build
```

`ask` and `search` accept `--doc <id prefix or file name>` to limit the search to one document, `--top-k <n>`, and `ask` accepts `--show-context` to print the chunks sent to the model. During development, `npm run dev -- <command>` runs the CLI without building. For faster but less reliable answers, set `PDF_OLLAMA_CHAT_MODEL=llama3.2:1b` (after `ollama pull llama3.2:1b`).

Re-ingesting an unchanged PDF is skipped; ingesting a changed file at the same path replaces the old version. Scanned pages without a text layer are reported but not indexed; run OCR first (for example `ocrmypdf input.pdf output.pdf`).

## Development

```sh
npm test            # unit tests, no Ollama needed
npm run typecheck   # source and tests
npm run lint        # Biome lint + format check (npm run format to fix)
npm run fixtures    # regenerate the sample PDFs in tests/fixtures
npm run evals       # measure retrieval and answers with Ollama (~10 min)
npm run evals -- --retrieval-only   # retrieval only, in seconds
```

`tests/fixtures/manual-nebula.pdf` is a synthetic, fictional employee handbook in Spanish. Every fact lives on a known page, page 6 is empty to simulate a scanned page, and nothing in it can be answered from a model's prior knowledge. `tests/fixtures/politica-alba.pdf` is a shorter policy of another fictional company with similar topics but different figures, used to check that answers do not mix up documents.

Run the evals before and after changing the prompt, chunking, `k`, or a model, and paste the metrics into the pull request. Reports are kept in `evals/results/` to compare runs.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and configuration.
