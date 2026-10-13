# Contexto del proyecto

App de chat con PDF (RAG): subo un PDF, hago preguntas en lenguaje natural y recibo respuestas con citas de página. Si la respuesta no está en el documento, debe decir que no lo sabe. Es un proyecto de aprendizaje y de portfolio: lo importante es que yo entienda cada decisión y pueda explicarla.

# Idioma y explicaciones

- Responde en español; el código, los nombres de variables, los comentarios y el README van en inglés.
- Explica los conceptos de IA aplicada (embeddings, RAG, evals) con claridad, sin darlos por sabidos.

# Cómo quiero que trabajes

- Antes de generar código, explica brevemente qué vas a hacer y por qué, y qué alternativa descartaste.
- Cambios pequeños: un módulo o una tarea por vez, nunca el proyecto entero de golpe.
- El núcleo de RAG (troceado, recuperación, prompt y citas) y los evals ya están implementados. Antes de cambiarlos, explícame la propuesta y espera mi confirmación: quiero entender cada cambio. Todo cambio de prompt, troceado, k o modelo se mide con `npm run evals` antes y después.
- Si algo es ambiguo, pregúntame antes de decidir.
- No añadas dependencias que no estén en el stack. Si crees que hace falta una, propónmela y espera.
- Cuando revises mi código, señala problemas de estructura, errores no contemplados y falta de tests, y dime el porqué.

# Stack y restricciones

- TypeScript sobre Node.js, módulos ES.
- Extracción de PDF por páginas con pdfjs-dist.
- Embeddings y chat con Ollama, en local y gratis. El proveedor debe poder cambiarse por otro (por ejemplo una API) sin tocar el resto del código.
- Almacén vectorial: SQLite integrado en Node (`node:sqlite`) con la extensión sqlite-vec.
- Cliente de Ollama: `fetch` nativo, sin librería.
- Lint y formato con Biome (`npm run lint`, `npm run format`).
- Tests con Vitest.
- CLI y una interfaz web local: servidor `node:http` y una página HTML/CSS/JS sin framework ni build, con textos en español.
- Todo debe poder ejecutarse sin coste.

# Limitaciones de hardware (importante)

- Portátil con CPU de 4 núcleos y 8 GB de RAM. Ollama solo usa CPU, sin GPU.
- Modelos: `bge-m3` para embeddings, porque es multilingüe y los PDFs son principalmente en español. `llama3.2:3b` para responder (es el modelo por defecto). `llama3.2:1b` solo para pruebas rápidas: en las pruebas manuales decía "no lo sé" aunque la respuesta estuviera en el documento. No propongas modelos más grandes.
- Los valores iniciales deben ser conservadores para que la respuesta no tarde demasiado: fragmentos de unos 400-500 tokens, solapamiento de unos 50-100, k = 3. Todo ajustable desde la configuración.
- La respuesta debe ir en streaming.
- No uses un modelo pequeño como juez en los evals. Usa comprobaciones automáticas (¿la página recuperada es la esperada? ¿aparece el dato clave en la respuesta?) más una revisión manual de una muestra.

# Arquitectura

Dos recorridos: indexar (extraer texto por página, trocear, calcular embeddings, guardar) y responder (embedding de la pregunta, buscar los k fragmentos más cercanos, construir el prompt, llamar al modelo, devolver texto y citas por separado).

````text
src/
  config.ts       valores ajustables (modelos, tamaño de fragmento, solapamiento, k, rutas)
  types.ts        Chunk, Answer, Citation
  ingest/         leer el PDF, trocear conservando la página e indexar sin duplicar
  embeddings/     interfaz Embedder + implementación para Ollama
  store/          interfaz VectorStore + implementación con SQLite
  retrieval/      buscar los k fragmentos relevantes
  ollama/         cliente HTTP compartido (timeouts, streaming, errores)
  generation/     interfaz ChatModel + prompt + llamada al modelo + citas
  cli.ts          interfaz de línea de comandos (incluye `serve` para la web)
  api/            servidor HTTP local: subir, listar, borrar y preguntar
public/           página web (HTML, CSS y JS sin build)
evals/            preguntas con respuesta y página esperadas, puntuación determinista, script e informes
scripts/          utilidades de desarrollo (generar el PDF de ejemplo)
tests/            un fichero de test por módulo
tests/fixtures/   PDF sintético en español con datos inventados en páginas conocidas
ARCHITECTURE.md   diagrama de módulos y decisiones
````

Reglas de diseño:

- Cada módulo depende de interfaces, no de implementaciones. Las interfaces son `Embedder`, `VectorStore` y `ChatModel`.
- Las citas salen de los metadatos de los fragmentos enviados al modelo, nunca de lo que el modelo diga.
- El prompt le indica al modelo que responda solo con el contexto, que cite la página de cada dato y que diga que no lo sabe si no está.
- No crees carpetas `utils` ni `helpers`.

# Convenciones

- Funciones pequeñas con una sola responsabilidad y tipos explícitos en las interfaces públicas.
- Errores contemplados: PDF vacío o escaneado, fichero que no es PDF, Ollama sin responder o con timeout, respuesta del modelo con formato inesperado.
- Sin secretos en el código. Configuración por variables de entorno o `config.ts`.
- Los tests no dependen del modelo real: usa dobles o respuestas fijas.