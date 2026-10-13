## Qué cambia y por qué
<!-- Una o dos frases. ¿Qué problema resuelve este PR? -->

## Estructura
- [ ] Cada fichero nuevo o cambiado tiene una sola responsabilidad
- [ ] Los módulos dependen de interfaces, no de implementaciones concretas
- [ ] No hay carpetas ni ficheros genéricos tipo `utils` con cosas sin relación
- [ ] No hay código muerto, comentarios que repiten lo que hace la línea ni funciones sin usar

## Configuración y dependencias
- [ ] Modelos, rutas, tamaños y otros valores ajustables están en la configuración, no repartidos por el código
- [ ] No hay claves ni secretos en el código ni en el historial
- [ ] Cada dependencia nueva está justificada (qué hace y por qué no basta lo que ya hay)

## Errores y casos límite
- [ ] Se contemplan: PDF vacío o sin texto, PDF escaneado, fichero que no es PDF
- [ ] Se contemplan: Ollama sin responder, timeout, respuesta del modelo con formato inesperado
- [ ] Los errores llegan al usuario con un mensaje útil, no con un stack trace

## Tests
- [ ] Hay al menos un test por módulo tocado, y fallan si rompo el comportamiento
- [ ] Los tests no dependen del modelo real (se usan dobles o respuestas fijas)
- [ ] Hay un caso de prueba para "la respuesta no está en el documento"

## Específico de IA
- [ ] Si cambió un prompt, el tamaño de fragmento, k o el modelo: he vuelto a pasar los evals y anotado el resultado

| Métrica | Antes | Después |
| --- | --- | --- |
| Acierto de recuperación (fragmento correcto en los k) | | |
| Respuestas correctas | | |
| Preguntas trampa respondidas con "no lo sé" | | |

- [ ] Las respuestas devuelven texto y páginas citadas por separado
- [ ] Sé qué coste o tiempo añade este cambio (tokens, latencia)

## Comprensión
- [ ] Puedo explicar con mis palabras qué hace cada fichero cambiado
- [ ] Lo que escribió la herramienta lo he leído línea a línea, no solo ejecutado
- [ ] Anoto abajo una cosa que no entendía y ya entiendo: