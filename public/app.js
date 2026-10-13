// Web interface for PDF Ollama: upload PDFs by drag and drop and ask questions.
// Plain browser JavaScript, no build step. All text is set with textContent,
// never innerHTML, so document content and answers cannot inject markup.

const elements = {
  dropzone: document.getElementById("dropzone"),
  chooseFiles: document.getElementById("choose-files"),
  fileInput: document.getElementById("file-input"),
  uploadList: document.getElementById("upload-list"),
  documentList: document.getElementById("document-list"),
  documentsEmpty: document.getElementById("documents-empty"),
  documentFilter: document.getElementById("document-filter"),
  messages: document.getElementById("messages"),
  chatEmpty: document.getElementById("chat-empty"),
  form: document.getElementById("question-form"),
  question: document.getElementById("question"),
  send: document.getElementById("send"),
  status: document.getElementById("status"),
};

const state = { documents: [], busy: false };

// ---------------------------------------------------------------- documents

async function loadDocuments() {
  const response = await fetch("/api/documents");
  if (!response.ok) {
    throw new Error(await errorFromResponse(response));
  }
  state.documents = await response.json();
  renderDocuments();
}

function renderDocuments() {
  elements.documentList.replaceChildren(...state.documents.map(documentItem));
  elements.documentsEmpty.hidden = state.documents.length > 0;

  const selected = elements.documentFilter.value;
  elements.documentFilter.replaceChildren(
    new Option("Todos los documentos", ""),
    ...state.documents.map((doc) => new Option(doc.fileName, doc.id)),
  );
  elements.documentFilter.value = state.documents.some(
    (doc) => doc.id === selected,
  )
    ? selected
    : "";
  updateControls();
}

function documentItem(doc) {
  const name = createElement("p", "document-name", doc.fileName);
  const meta = createElement(
    "p",
    "document-meta",
    `${plural(doc.pageCount, "página", "páginas")} · ${plural(doc.chunkCount, "fragmento", "fragmentos")}`,
  );
  const info = createElement("div", "document-info");
  info.append(name, meta);

  const summarize = createElement("button", "summary-button", "Resumir");
  summarize.type = "button";
  summarize.setAttribute("aria-label", `Resumir ${doc.fileName}`);
  summarize.addEventListener("click", () => summarizeDocument(doc));

  const remove = createElement("button", "delete-button", "Eliminar");
  remove.type = "button";
  remove.setAttribute("aria-label", `Eliminar ${doc.fileName}`);
  remove.addEventListener("click", () => deleteDocument(doc));

  const actions = createElement("div", "document-actions");
  actions.append(summarize, remove);

  const item = createElement("li", "document-item");
  item.append(info, actions);
  return item;
}

async function deleteDocument(doc) {
  const confirmed = window.confirm(
    `¿Eliminar «${doc.fileName}»? Tendrás que volver a subirlo para preguntarle.`,
  );
  if (!confirmed) {
    return;
  }
  try {
    const response = await fetch(`/api/documents/${doc.id}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(await errorFromResponse(response));
    }
    setStatus(`Se ha eliminado «${doc.fileName}».`);
    await loadDocuments();
  } catch (error) {
    setStatus(translateError(error.message), true);
  }
}

// ------------------------------------------------------------------ uploads

async function uploadFiles(fileList) {
  const files = [...fileList];
  const pdfs = files.filter(isPdf);
  const rejected = files.filter((file) => !isPdf(file));
  if (rejected.length > 0) {
    setStatus(
      `Solo se admiten PDFs. Se ha ignorado: ${rejected.map((file) => file.name).join(", ")}.`,
      true,
    );
  }
  if (pdfs.length === 0 || state.busy) {
    return;
  }

  setBusy(true);
  try {
    for (const file of pdfs) {
      await uploadFile(file);
    }
  } finally {
    setBusy(false);
    await loadDocuments().catch((error) =>
      setStatus(translateError(error.message), true),
    );
  }
}

async function uploadFile(file) {
  const item = createUploadItem(file.name);
  try {
    const response = await fetch(
      `/api/documents?name=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: file,
      },
    );
    if (!response.ok) {
      throw new Error(await errorFromResponse(response));
    }

    await readEvents(response, (event) => {
      if (event.type === "started") {
        item.update("Extrayendo el texto…");
      } else if (event.type === "progress") {
        item.update(
          `Procesando fragmentos ${event.done}/${event.total}…`,
          event.done,
          event.total,
        );
      } else if (event.type === "done") {
        item.finish(describeUpload(event), event.pagesWithoutText.length > 0);
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    });
  } catch (error) {
    item.fail(translateError(error.message));
  }
}

function describeUpload(event) {
  const { document: doc, status, pagesWithoutText } = event;
  let message =
    status === "unchanged"
      ? "Ya estaba cargado; no se ha duplicado."
      : `Listo: ${plural(doc.pageCount, "página", "páginas")}, ${plural(doc.chunkCount, "fragmento", "fragmentos")}.`;
  if (pagesWithoutText.length > 0) {
    message += ` Sin texto en ${pagesWithoutText.length === 1 ? "la página" : "las páginas"} ${pagesWithoutText.join(", ")}: puede que estén escaneadas y no se podrán consultar.`;
  }
  return message;
}

function createUploadItem(fileName) {
  const item = createElement("li", "upload-item");
  const name = createElement("p", "document-name", fileName);
  const progress = document.createElement("progress");
  const message = createElement("p", "message", "Subiendo…");
  item.append(name, progress, message);
  elements.uploadList.prepend(item);

  return {
    update(text, done, total) {
      message.textContent = text;
      if (total !== undefined) {
        progress.max = total;
        progress.value = done;
      }
    },
    finish(text, hasWarning) {
      progress.remove();
      message.textContent = text;
      item.classList.add(hasWarning ? "warning" : "success");
      if (!hasWarning) {
        setTimeout(() => item.remove(), 6000);
      }
    },
    fail(text) {
      progress.remove();
      message.textContent = text;
      item.classList.add("error");
      const close = createElement("button", "delete-button", "Cerrar");
      close.type = "button";
      close.addEventListener("click", () => item.remove());
      item.append(close);
    },
  };
}

function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/iu.test(file.name);
}

// ---------------------------------------------------------------- questions

async function askQuestion(question) {
  elements.chatEmpty.hidden = true;
  addUserMessage(question);
  const answer = addAssistantMessage();

  setBusy(true);
  try {
    const documentId = elements.documentFilter.value || undefined;
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, documentId }),
    });
    if (!response.ok) {
      throw new Error(await errorFromResponse(response));
    }

    await readEvents(response, (event) => {
      if (event.type === "text_delta") {
        answer.append(event.text);
      } else if (event.type === "citations") {
        answer.showSources(event.citations);
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    });
    answer.done();
    if (asksForSummary(question)) {
      answer.note(
        "Para resumir un documento entero, usa el botón «Resumir» junto a él: las preguntas solo leen los fragmentos más parecidos a la pregunta.",
      );
    }
  } catch (error) {
    answer.fail(translateError(error.message));
  } finally {
    setBusy(false);
    elements.question.focus();
  }
}

function asksForSummary(question) {
  return /\b(res[uú]m(e|en|eme|elo|ir|ime)|s[ií]ntesis)\b/iu.test(question);
}

// ---------------------------------------------------------------- summaries

async function summarizeDocument(doc, refresh = false) {
  if (state.busy) {
    return;
  }
  elements.chatEmpty.hidden = true;
  addUserMessage(`Resume «${doc.fileName}»`);
  const answer = addAssistantMessage("Leyendo el documento…");

  setBusy(true);
  try {
    const response = await fetch(`/api/documents/${doc.id}/summary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh }),
    });
    if (!response.ok) {
      throw new Error(await errorFromResponse(response));
    }

    await readEvents(response, (event) => {
      if (event.type === "progress") {
        answer.setPending(`Resumiendo parte ${event.done} de ${event.total}…`);
      } else if (event.type === "text_delta") {
        answer.append(event.text);
      } else if (event.type === "done") {
        answer.done();
        if (event.cached) {
          answer.note("Resumen guardado de una vez anterior.", {
            label: "Volver a generarlo",
            onClick: () => summarizeDocument(doc, true),
          });
        }
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    });
  } catch (error) {
    answer.fail(translateError(error.message));
  } finally {
    setBusy(false);
  }
}

function addUserMessage(text) {
  elements.messages.append(createElement("div", "message-bubble user", text));
  scrollToBottom();
}

function addAssistantMessage(pendingLabel = "Pensando…") {
  const bubble = createElement("div", "message-bubble assistant pending");
  const text = createElement("div", "answer-text", pendingLabel);
  bubble.append(text);
  elements.messages.append(bubble);
  scrollToBottom();

  // Answers can take a while on CPU, so show how long we have been waiting.
  const startedAt = Date.now();
  let label = pendingLabel;
  const timer = setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    text.textContent = `${label} (${seconds} s)`;
  }, 1000);
  let answer = "";

  return {
    setPending(newLabel) {
      label = newLabel;
      if (answer === "") {
        text.textContent = newLabel;
      }
    },
    note(message, action) {
      const note = createElement("div", "answer-note", message);
      if (action) {
        const button = createElement("button", "link-button", action.label);
        button.type = "button";
        button.addEventListener("click", action.onClick);
        note.append(" ", button);
      }
      bubble.append(note);
      scrollToBottom();
    },
    append(delta) {
      if (answer === "") {
        clearInterval(timer);
        bubble.classList.remove("pending");
      }
      answer += delta;
      text.textContent = answer;
      scrollToBottom();
    },
    showSources(citations) {
      if (citations.length === 0) {
        return;
      }
      const sources = createElement("div", "sources", "Fuentes:");
      for (const citation of citations) {
        sources.append(
          createElement(
            "span",
            "source-chip",
            `${citation.fileName} · p. ${citation.pageNumber}`,
          ),
        );
      }
      bubble.append(sources);
      scrollToBottom();
    },
    done() {
      clearInterval(timer);
      if (answer === "") {
        text.textContent = "No se ha recibido ninguna respuesta.";
      }
    },
    fail(message) {
      clearInterval(timer);
      bubble.classList.remove("pending");
      bubble.classList.add("error");
      text.textContent = message;
    },
  };
}

function scrollToBottom() {
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

// ------------------------------------------------------------------ helpers

/** Reads a newline-delimited JSON response, calling onEvent for each line. */
async function readEvents(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (line.trim() !== "") {
        onEvent(JSON.parse(line));
      }
    }
    if (done) {
      return;
    }
  }
}

async function errorFromResponse(response) {
  try {
    const body = await response.json();
    return body.error ?? `Error ${response.status}`;
  } catch {
    return `Error ${response.status}`;
  }
}

/** Shows the most common server errors in Spanish. */
function translateError(message) {
  const translations = [
    [
      /Could not connect to Ollama/u,
      "No se puede conectar con Ollama. ¿Está arrancado? Ábrelo o ejecuta «ollama serve».",
    ],
    [
      /did not respond within/u,
      "Ollama ha tardado demasiado en responder. Prueba de nuevo o aumenta PDF_OLLAMA_TIMEOUT_MS.",
    ],
    [/not a PDF/u, "El fichero no es un PDF válido."],
    [
      /no extractable text/u,
      "El PDF no tiene texto que se pueda leer; puede que esté escaneado. Pásale antes un OCR (por ejemplo, ocrmypdf).",
    ],
    [/larger than the (\d+) MB/u, "El PDF supera el tamaño máximo de $1 MB."],
    [/HTTP 404.*not found/u, `Falta un modelo en Ollama. Detalle: ${message}`],
    [
      /different embedding model/u,
      `Hay documentos procesados con otro modelo de embeddings. Vuelve a subirlos. Detalle: ${message}`,
    ],
    [
      /Failed to fetch|NetworkError|Load failed/u,
      "No se puede conectar con el servidor de PDF Ollama. ¿Sigue en marcha?",
    ],
  ];
  for (const [pattern, translation] of translations) {
    const match = message.match(pattern);
    if (match) {
      return translation.replace("$1", match[1] ?? "");
    }
  }
  return message;
}

function setBusy(busy) {
  state.busy = busy;
  updateControls();
}

function updateControls() {
  const noDocuments = state.documents.length === 0;
  elements.question.disabled = state.busy || noDocuments;
  elements.send.disabled = state.busy || noDocuments;
  elements.documentFilter.disabled = state.busy || noDocuments;
  elements.chooseFiles.disabled = state.busy;
  elements.dropzone.classList.toggle("disabled", state.busy);
  for (const button of elements.documentList.querySelectorAll("button")) {
    button.disabled = state.busy;
  }
}

function setStatus(text, isError = false) {
  elements.status.textContent = text;
  elements.status.classList.toggle("error", isError);
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

// ------------------------------------------------------------------- events

elements.chooseFiles.addEventListener("click", () =>
  elements.fileInput.click(),
);
elements.fileInput.addEventListener("change", () => {
  uploadFiles(elements.fileInput.files);
  elements.fileInput.value = "";
});

for (const type of ["dragenter", "dragover"]) {
  elements.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    if (!state.busy) {
      elements.dropzone.classList.add("dragging");
    }
  });
}
elements.dropzone.addEventListener("dragleave", () =>
  elements.dropzone.classList.remove("dragging"),
);
elements.dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.dropzone.classList.remove("dragging");
  if (state.busy) {
    setStatus("Espera a que termine la tarea en curso.", true);
    return;
  }
  uploadFiles(event.dataTransfer.files);
});
// Dropping a file outside the drop zone must not navigate away from the page.
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (event) => event.preventDefault());
}

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = elements.question.value.trim();
  if (question === "" || state.busy) {
    return;
  }
  elements.question.value = "";
  setStatus("");
  askQuestion(question);
});
elements.question.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.form.requestSubmit();
  }
});

loadDocuments().catch((error) =>
  setStatus(translateError(error.message), true),
);
