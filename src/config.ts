import { join } from "node:path";

export interface AppConfig {
  models: {
    embedding: string;
    chat: string;
  };
  chunking: {
    size: number;
    overlap: number;
  };
  embedding: {
    batchSize: number;
  };
  retrieval: {
    topK: number;
  };
  generation: {
    temperature: number;
    contextWindow: number;
  };
  ollama: {
    baseUrl: string;
    timeoutMs: number;
  };
  paths: {
    dataDirectory: string;
    databaseFile: string;
  };
}

export type Environment = Readonly<Record<string, string | undefined>>;

/** Builds and validates the application configuration from environment variables. */
export function loadConfig(env: Environment = process.env): AppConfig {
  const dataDirectory = env.PDF_OLLAMA_DATA_DIR ?? "./data";
  const config: AppConfig = {
    models: {
      embedding: env.PDF_OLLAMA_EMBEDDING_MODEL ?? "bge-m3",
      chat: env.PDF_OLLAMA_CHAT_MODEL ?? "llama3.2:3b",
    },
    chunking: {
      size: readInteger(env, "PDF_OLLAMA_CHUNK_SIZE", 450, 1),
      overlap: readInteger(env, "PDF_OLLAMA_CHUNK_OVERLAP", 75, 0),
    },
    embedding: {
      batchSize: readInteger(env, "PDF_OLLAMA_EMBEDDING_BATCH_SIZE", 16, 1),
    },
    retrieval: {
      topK: readInteger(env, "PDF_OLLAMA_TOP_K", 3, 1),
    },
    generation: {
      temperature: readNumber(env, "PDF_OLLAMA_TEMPERATURE", 0, 0),
      contextWindow: readInteger(env, "PDF_OLLAMA_NUM_CTX", 4096, 512),
    },
    ollama: {
      baseUrl: (env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(
        /\/+$/u,
        "",
      ),
      timeoutMs: readInteger(env, "PDF_OLLAMA_TIMEOUT_MS", 120000, 1),
    },
    paths: {
      dataDirectory,
      databaseFile:
        env.PDF_OLLAMA_DATABASE_FILE ?? join(dataDirectory, "pdf-ollama.db"),
    },
  };

  if (config.chunking.overlap >= config.chunking.size) {
    throw new Error(
      "PDF_OLLAMA_CHUNK_OVERLAP must be smaller than PDF_OLLAMA_CHUNK_SIZE.",
    );
  }

  return config;
}

function readInteger(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const value = readNumber(env, name, fallback, minimum);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got "${env[name]}".`);
  }
  return value;
}

function readNumber(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a number >= ${minimum}, got "${raw}".`);
  }
  return value;
}
