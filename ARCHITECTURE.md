# Architecture

The application has two workflows. Ingestion extracts text per PDF page, creates page-aware text chunks, embeds them, and stores them. Answering embeds the question, retrieves relevant chunks, streams a response from a replaceable chat model, and returns citations separately from generated text.

```mermaid
flowchart LR
    subgraph Indexing
        PDF[PDF file] --> Ingest[Page extraction and chunking]
        Ingest --> Embed[Embedder]
        Embed --> Store[VectorStore]
    end

    subgraph Answering
        Question[Question] --> Retrieval[Retrieval]
        Store --> Retrieval
        Retrieval --> Context[Retrieved chunks]
        Context --> Generation[Generation]
        Chat[ChatModel] --> Generation
        Generation --> Text[Answer text stream]
        Context --> Citations[Page citations from metadata]
    end

    OllamaEmbedding[Ollama embedding adapter] -. implements .-> Embed
    SQLite[node:sqlite and sqlite-vec adapter] -. implements .-> Store
    OllamaChat[Ollama chat adapter] -. implements .-> Chat
```

## Decisions

- TypeScript uses ES modules and targets Node.js 24 or newer.
- `Embedder`, `VectorStore`, and `ChatModel` are contracts so provider and storage implementations can be replaced independently. The Ollama adapters use the built-in `fetch` (no client library) and share `src/ollama/ollama-http.ts` for timeouts, NDJSON streaming, and user-facing error messages.
- **Extraction** uses `pdfjs-dist` page by page, keeping line breaks and joining words hyphenated across lines. Pages without text are kept empty and reported as possibly scanned; a PDF with no text at all is rejected. OCR is not included.
- **Chunking** never crosses a page boundary, so every chunk has exactly one page to cite. Text is split into sentences (words for very long sentences) and packed greedily up to the chunk size; each chunk starts with the trailing sentences of the previous one, up to the overlap. Sizes are in approximate tokens (4 characters per token), with no tokenizer dependency.
- **Embeddings** default to `bge-m3` because documents are mostly in Spanish and it is multilingual; it needs no query/document prefixes. Changing the embedding model requires re-ingesting: documents record the model, and searches refuse documents indexed with another one.
- **Storage** uses the built-in `node:sqlite` plus the `sqlite-vec` extension: regular tables for documents and chunks, and a `vec0` table (cosine distance, created on first write with the model's dimension) sharing the chunk rowid. Search is exact KNN, optionally filtered by document. No server is needed.
- **Re-ingestion**: a document id is the SHA-256 of the file. Same content and settings → skipped. Otherwise the document, and any earlier document from the same path, is replaced in one transaction, so data is never duplicated.
- **Generation** uses a Spanish system prompt (small models follow it more consistently in the documents' language) that restricts answers to the retrieved chunks, asks for `[p. N]` after each fact, and requires the exact reply `No lo sé: el documento no contiene esa información.` when the answer is missing. `temperature` is 0 and `num_ctx` is set explicitly, because Ollama silently truncates prompts that exceed it.
- **Citations** come from retrieved chunk metadata, never from model text alone: if the answer cites some retrieved pages as `[p. N]`, only those are shown; otherwise all retrieved pages are. A "don't know" answer has no citations.
- Timeouts are inactivity timeouts: a long streamed answer is fine as long as tokens keep arriving.
- Defaults are conservative for an 8 GB, CPU-only machine: 450 tokens per chunk, 75 tokens of overlap, `topK` 3. The default chat model is `llama3.2:3b`; an answer takes roughly 30–60 s. `llama3.2:1b` is faster but, in manual tests, often answered "I don't know" when the answer was present.
- Initial configuration keys use the `PDF_OLLAMA_` prefix; `OLLAMA_BASE_URL` follows Ollama's common environment variable name.
- **Web interface**: `pdf-ollama serve` (`npm run web`) starts a `node:http` server in `src/api/` that serves a single page from `public/` (plain HTML, CSS, and JavaScript in Spanish, no build step) and a small API:
  - `GET /api/documents`, `DELETE /api/documents/:id`
  - `POST /api/documents?name=<file name>` with the raw PDF body; streams NDJSON `started`, `progress`, and `done` or `error` events. Uploads are indexed from memory under the source path `upload/<file name>` and are not written to disk, so uploading a new version with the same name replaces the old one.
  - `POST /api/ask` with JSON `{ question, documentId? }`; streams `text_delta` events, then `citations` (with file names), or `error`.
- The server listens on `127.0.0.1` only, rejects requests whose `Host` is not localhost (DNS rebinding), and requires `application/pdf` or `application/json` bodies, so other websites cannot call it through the browser. Uploads and answers run one at a time because CPU-only Ollama slows down with parallel requests. The page uses `textContent` only and a `default-src 'self'` content security policy.
- **Evals** (`npm run evals`, code in `evals/`) measure the pipeline against `evals/dataset.json`: questions over the two fixture PDFs, each with its document, expected pages, and expected facts, plus trap questions whose answer is in no document. Scoring is deterministic and never uses a model as judge: retrieval hit (all expected pages among the top k) and MRR, answer correctness (every expected fact present, ignoring case, accents, and Spanish number formatting, and not a "don't know"), page cited, and "don't know" for traps. Each run ingests the fixtures into a fresh `data/evals.db`, prints the pull request template metrics, and writes a Markdown report with a random sample for manual review to `evals/results/` (committed; the raw JSON is ignored). `--retrieval-only` skips generation and takes seconds; a full run takes about 10 minutes with `llama3.2:3b` on CPU. A unit test checks that every expected fact really appears on its expected page.
- **Eval findings** (reports in `evals/results/`, `llama3.2:3b`):
  - Baseline: retrieval 18/19, correct answers 18/19, traps 4/5, expected page cited 19/19, about 20 s per answer.
  - Labelling each chunk with its document name in the prompt, adding rules about other documents and paraphrased questions, or raising `k` to 4 did not improve answers (15–17/19). With `k` = 4 retrieval reached 19/19, but the extra chunk confused the model. The original prompt and `k` = 3 were kept.
  - Known limitations: with several similar PDFs indexed, the model can attribute a fact from one document to another (the "Cooperativa Alba" trap); limit the question to one document (`--doc` in the CLI, the selector in the web page) when that matters. Questions that combine two topics may miss one with `k` = 3. Answers are sensitive to wording: "¿Cuánto me pagan al mes por teletrabajar?" once got "No lo sé" while the same question naming the company was answered correctly.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PDF_OLLAMA_EMBEDDING_MODEL` | `bge-m3` | Embedding model name |
| `PDF_OLLAMA_CHAT_MODEL` | `llama3.2:3b` | Chat model name |
| `PDF_OLLAMA_CHUNK_SIZE` | `450` | Target chunk size in tokens |
| `PDF_OLLAMA_CHUNK_OVERLAP` | `75` | Chunk overlap in tokens (must be smaller than the size) |
| `PDF_OLLAMA_EMBEDDING_BATCH_SIZE` | `16` | Chunks per embedding request |
| `PDF_OLLAMA_TOP_K` | `3` | Number of retrieved chunks |
| `PDF_OLLAMA_TEMPERATURE` | `0` | Chat sampling temperature |
| `PDF_OLLAMA_NUM_CTX` | `4096` | Chat context window in tokens |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `PDF_OLLAMA_TIMEOUT_MS` | `120000` | Maximum time without a response from Ollama |
| `PDF_OLLAMA_DATA_DIR` | `./data` | Local application data directory |
| `PDF_OLLAMA_DATABASE_FILE` | `<data dir>/pdf-ollama.db` | SQLite database file |
| `PDF_OLLAMA_PORT` | `3000` | Web interface port (always on `127.0.0.1`) |
| `PDF_OLLAMA_MAX_UPLOAD_MB` | `100` | Maximum PDF size for web uploads |

Invalid numeric values stop the CLI with a message naming the variable.
