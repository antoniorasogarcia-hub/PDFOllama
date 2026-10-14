# PDFOllama

[![CI](https://github.com/antoniorasogarcia-hub/PDFOllama/actions/workflows/ci.yml/badge.svg)](https://github.com/antoniorasogarcia-hub/PDFOllama/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Chat with your PDFs, privately. Drop PDFs onto a local web page, ask questions in natural language, and check every answer against the source: each response cites the pages it came from and says "No lo sé" ("I don't know") when the documents don't contain the answer. You can also get a summary of a whole document.

Everything runs on your own machine with [Ollama](https://ollama.com). Your documents never leave your computer, and there are no API keys or costs.

The interface and prompts are in Spanish, because the project was built for mostly Spanish documents. The prompt asks the model to answer in the language of the question.

## Features

- **Questions with page citations.** Retrieval-augmented generation (RAG): the question is matched against the documents, and the model answers only from the closest passages. Sources come from the matched passages' metadata, not from the model's text.
- **"I don't know" instead of inventing.** Questions whose answer is not in the documents get an explicit "No lo sé".
- **Whole-document summaries.** A short introduction plus key points with their pages. Long documents are summarized section by section, and summaries are saved so the next request is instant.
- **Several PDFs at once.** Ask all of them, or limit a question to one document.
- **Web interface and CLI.** Drag and drop in the browser, or script it from the terminal.
- **Measured, not guessed.** Deterministic evals (no model as judge) for retrieval, answers, "I don't know" questions, and summaries. Results are in [`evals/results/`](evals/results).

## Requirements

| | |
| --- | --- |
| Operating system | macOS, Linux or Windows (developed and tested on macOS) |
| Node.js | **24 or newer** (the built-in `node:sqlite` module is required) |
| Ollama | Recent version, running locally |
| Memory | 8 GB of RAM is enough; no GPU needed |
| Disk | About 3.5 GB for the two models |

On a CPU-only laptop, an answer takes roughly 10–60 seconds and the first summary of a document takes minutes. With a GPU, Ollama is much faster.

## Installation

### 1. Install Node.js 24

Download it from <https://nodejs.org>, or use a version manager such as [nvm](https://github.com/nvm-sh/nvm):

```sh
nvm install 24
node --version   # v24.x.x
```

### 2. Install Ollama and download the models

Install Ollama from <https://ollama.com/download>. On Linux you can also run `curl -fsSL https://ollama.com/install.sh | sh`. Make sure it is running (on macOS and Windows, open the app; on Linux, run `ollama serve` if it is not running as a service), then download the two models:

```sh
ollama pull bge-m3        # embeddings, multilingual (~1.2 GB)
ollama pull llama3.2:3b   # answers and summaries (~2.0 GB)
ollama list               # both should be listed
```

### 3. Get the project

```sh
git clone https://github.com/antoniorasogarcia-hub/PDFOllama.git
cd PDFOllama
npm ci
```

### 4. Start it

```sh
npm run web
```

Open <http://localhost:3000>, drag one or more PDFs onto the page, and ask questions once they are processed. Use **Resumir** next to a document for a whole-document summary. Stop the server with `Ctrl+C`.

To try it without your own files, use the sample PDFs in [`tests/fixtures/`](tests/fixtures). They describe fictional companies, so the model cannot answer from prior knowledge. For example, upload `manual-nebula.pdf` and ask "¿Cuántos días de vacaciones tengo al año?".

## Using the command line

```sh
npm run build

node dist/cli.js ingest file.pdf [more.pdf...]   # index PDFs
node dist/cli.js list                            # indexed documents
node dist/cli.js ask "¿Cuántos días de vacaciones tengo?"
node dist/cli.js chat                            # several questions in a row
node dist/cli.js summarize file.pdf              # whole-document summary (--refresh to redo)
node dist/cli.js search "hotel"                  # inspect retrieved chunks and their scores
node dist/cli.js remove file.pdf
node dist/cli.js serve                           # the web interface, from the build
```

`ask`, `chat` and `search` accept `--doc <file name or id prefix>` to use only one document and `--top-k <n>` to change how many passages are retrieved. `ask` also accepts `--show-context` to print the passages sent to the model. During development, `npm run dev -- <command>` runs the CLI without building.

## Configuration

Settings are read from environment variables. The most useful ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PDF_OLLAMA_CHAT_MODEL` | `llama3.2:3b` | Model for answers and summaries |
| `PDF_OLLAMA_EMBEDDING_MODEL` | `bge-m3` | Model for embeddings (re-ingest documents after changing it) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server |
| `PDF_OLLAMA_DATA_DIR` | `./data` | Where the local database is stored |
| `PDF_OLLAMA_PORT` | `3000` | Web interface port |

For example, `PDF_OLLAMA_CHAT_MODEL=llama3.2:1b npm run web` gives faster but noticeably less reliable answers. All variables are listed in [ARCHITECTURE.md](ARCHITECTURE.md#environment-variables).

## Privacy and security

- The web server only listens on `127.0.0.1`, so other devices on your network cannot reach it.
- It rejects requests addressed to other host names and requests without the expected content type, so websites open in your browser cannot use it.
- Uploaded PDFs are not stored as files. Only their extracted text, embeddings, and summaries are kept in the local SQLite database in `data/`. Deleting a document in the interface removes all of it.
- Nothing is sent outside your machine unless you point `OLLAMA_BASE_URL` to another server.

## Limitations

These come from the evals and manual testing with `llama3.2:3b` (details in [ARCHITECTURE.md](ARCHITECTURE.md)):

- **Scanned PDFs** are not read: pages without a text layer are reported and skipped. Run OCR first, for example with [`ocrmypdf`](https://ocrmypdf.readthedocs.io).
- **Similar documents can be mixed up.** With several similar PDFs, a small model may attribute a fact from one to another. The sources shown under the answer reveal it, and choosing the document in "Preguntar a" avoids it.
- **Questions that combine two topics** may miss one of them.
- **Wording matters.** Rephrasing a question, or naming the document or company, sometimes turns an "I don't know" into the right answer.
- **Tables** lose their structure in text extraction.
- **Questions are independent.** A follow-up such as "¿y en agosto?" does not know what you asked before.
- **Speed** depends on your hardware; summaries of long PDFs can take a long time the first time.

## Development

```sh
npm test            # unit tests (no Ollama needed)
npm run typecheck   # source and tests
npm run lint        # Biome lint and format check (npm run format to fix)
npm run fixtures    # regenerate the sample PDFs
npm run evals                       # retrieval and answers with Ollama (~10 min)
npm run evals -- --retrieval-only   # retrieval only, in seconds
npm run evals -- --summaries        # summary coverage and invented figures
```

Run the evals before and after changing a prompt, the chunking, `k`, or a model, and compare the reports in `evals/results/`. The design, the decisions and their trade-offs, and the eval findings are documented in [ARCHITECTURE.md](ARCHITECTURE.md).

### Project structure

```text
src/
  ingest/       PDF text extraction per page, chunking, indexing without duplicates
  embeddings/   Embedder interface and Ollama implementation
  store/        VectorStore interface and SQLite + sqlite-vec implementation
  retrieval/    finding the most relevant chunks for a question
  generation/   prompt, Ollama chat model, answers with citations
  summary/      whole-document summaries, section by section, with a cache
  ollama/       shared Ollama HTTP client (timeouts, streaming, errors)
  api/          local HTTP server for the web interface
  cli.ts        command-line interface
public/         web page (HTML, CSS and JavaScript, no build step)
evals/          evaluation dataset, deterministic scoring, and reports
tests/          unit tests and synthetic sample PDFs
```

## How this project was built

This is a learning and portfolio project built with AI-assisted development ("vibe coding") using [Claude Code](https://claude.com/claude-code). I set the goals, constraints, and conventions (local-only, TypeScript, Ollama, small models on a CPU-only laptop, no model as eval judge), reviewed each step, and decided what to keep; the AI agent wrote most of the code, tests, and documentation. Commits co-authored by the agent say so in their message. Design decisions, including experiments that did not work and were reverted, are recorded in [ARCHITECTURE.md](ARCHITECTURE.md) and in the eval reports.

## License

[MIT](LICENSE)
