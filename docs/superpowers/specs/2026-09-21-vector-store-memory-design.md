# Memoria del vector store: sacar los gigas del proceso principal

Fecha: 2026-09-21
Estado: **C y A implementados y medidos** (rama `perf/vector-store-arena`, PR #5). **B pendiente**,
con el diseño replanteado abajo: se parte por datos, no por API. La misma rama sacó ademas el
embedder local a un `utilityProcess` con liberacion por inactividad; eso no es B — B es el vector
store — y esta documentado en el commit `feat(embeddings)` y en `docs/performance/`.

Medido con la rama contra la biblioteca real (2026-09-21 22:30 AR): proceso principal 1.345 MB
(antes 2.900 de working set), renderer 423 MB, boot 6,0 s (antes 17,0). En reposo la app queda en
~1,9 GB; el piso son los 977 MB de la particion activa en el main, que es lo que B mueve.

## El problema, medido

El proceso principal de Electron llegó a **8,47 GB comprometidos** con la app
abierta y en reposo. La máquina se colgó con la app corriendo junto a 22
sesiones de agentes.

Medición directa sobre `F:\HiDock-Next-Data\data\hidock.db` (2.757 MB,
237.920 filas en `vector_embeddings`):

| Concepto | En disco | Costo en el heap de V8 |
|---|---|---|
| `embedding`, `local-onnx-embed`, 2048 dims — **partición activa** | 977 MB | 977 MB |
| `embedding`, `gemini-api`, 3072 dims | 1.321 MB | no se carga |
| `embedding`, `ollama`, 768 dims, 61 filas | ~0 MB | no se carga |
| `content`, 433 bytes promedio | 98 MB | ~206 MB (UTF-16 + header) |
| `id` / `subject` / `meeting_id` / `recording_id` | 36 MB | ~108 MB |
| objetos `VectorDocument` + entradas del `Map` | — | ~45 MB |
| **Total de estado vivo** | | **~1,34 GB** |

El estado vivo es 1,34 GB. El proceso pedía 8,47 GB de memoria comprometida,
con un working set de 2,9 GB.

> **Corrección (2026-09-21, después de medir).** La primera versión de este
> documento afirmaba que los ~7 GB de diferencia eran desperdicio del camino de
> carga, y que arreglarlo los recuperaba. **Es falso, y la medición lo
> desmiente.** Una sonda contra la base real (125.063 filas × 2048 dims) cargando
> la partición por los dos caminos da:
>
> | Camino | RSS | Delta RSS | arrayBuffers |
> |---|---|---|---|
> | Una `ArrayBuffer` por fila (el viejo) | 1.404 MB | 1.321 MB | 987 MB |
> | Arena contigua (el nuevo) | 1.242 MB | 1.159 MB | 1.014 MB |
>
> La diferencia es de 160 MB, un 12%, no varios gigas. Cargar la partición
> cuesta ~1,3 GB por cualquiera de los dos caminos, que es exactamente el
> estado vivo calculado arriba. El error fue comparar memoria *comprometida*
> del proceso contra una estimación de *heap*: son métricas distintas y no se
> restan.
>
> Queda abierto de dónde salía el resto del número de 8,47 GB. Requiere medir
> con la app corriendo y con instrumentación dentro del proceso principal, no
> desde afuera. Hasta tenerlo, este documento no afirma que exista desperdicio
> recuperable ahí.

**Lo que sí queda establecido:** la partición activa son 977 MB de vectores que
hoy viven en el proceso principal, y mientras vivan ahí el proceso no baja de
~1,3 GB. El objetivo de ~1 GB no se alcanza optimizando cómo se cargan; se
alcanza no teniéndolos en ese proceso.

## Las tres causas del desperdicio

Todas en `apps/electron/electron/main/services/vector-store.ts`.

### 1. Una `ArrayBuffer` por fila

`blobToEmbedding()` (línea 97) hace:

```ts
return new Float32Array(bytes.buffer.slice(bytes.byteOffset, ...))
```

`.slice()` asigna una `ArrayBuffer` nueva por cada fila. Para la partición
activa son **125.063 asignaciones independientes de ~8 KB**. Cada una lleva
overhead de malloc y fragmenta el heap nativo. El comentario de la línea 79
dice que el camino del BLOB devuelve una "vista" sin boxing, y es cierto que
evitó el `Array.from()` de 338M de números — pero sigue copiando.

### 2. Un objeto descartable por fila

`loadFromDatabase()` (línea 547) arma, para cada fila:

```ts
const doc: Record<string, unknown> = {}
columns.forEach((col, i) => { doc[col] = row[i] })
```

Un objeto intermedio de 13 claves por fila, 125.063 veces, que se descarta
inmediatamente después de construir el `VectorDocument`. Es basura pura para
el GC durante todo el boot.

### 3. `SELECT *` trae `content` para todo

La query pide todas las columnas de todas las filas de la partición. El
`content` (98 MB en disco, ~206 MB como string JS) queda residente para
siempre, cuando solo se necesita para los top-K de cada búsqueda: 5 filas.

## El diseño

Tres cambios, en este orden. Cada uno se mide antes de pasar al siguiente.

### C — Arreglar el camino de carga

No cambia ninguna interfaz. Ninguno de los 13 archivos consumidores se toca.

- **Un solo buffer contiguo por partición.** Antes del bucle, `SELECT
  COUNT(*), embed_dims` para la partición activa y asignar **una** `Float32Array`
  de `filas × dims` (125.063 × 2048 = 1.024 MB). El `embedding` de cada
  documento pasa a ser una `subarray()` sobre ese buffer, en su offset. Esto
  elimina las 125.063 asignaciones del punto 1 y deja los vectores en una sola
  región contigua.
- **Eliminar el objeto intermedio.** Resolver los índices de columna una vez,
  fuera del bucle, y leer `row[idxContent]` directamente. Elimina el punto 2.
- **Listar columnas explícitamente** en vez de `SELECT *`.

**Resultado real, medido: 160 MB (1.321 → 1.159 MB de delta RSS).** Muy por
debajo de lo que este documento predijo. Se mantiene igual porque es una mejora
real sin costo de interfaz, elimina 125.063 asignaciones nativas y la
fragmentación que traían, y acorta el boot de 2.378 a 2.192 ms. Pero no es la
palanca: la palanca es B.

### A — Sacar `content` de memoria

Cambia el tipo de `VectorDocument.content` de `string` a un getter perezoso.

- `content` deja de cargarse en `loadFromDatabase` y en `tryLoadFromCache`.
- `search()` ya devuelve `SearchResult[]` con los top-K; ahí se hace un
  `SELECT content FROM vector_embeddings WHERE id IN (...)` con los 5 ids
  ganadores y se completa el campo.
- `getChunkNeighbors()` y `searchByMeeting()` devuelven `VectorDocument[]` y
  también necesitan hidratar. Ambos trabajan sobre conjuntos acotados.
- `getAllDocuments()` es el único que hoy podría devolver 125k documentos con
  su texto. Revisar sus llamadores: si nadie necesita `content`, no se hidrata.

  **Revisado y cerrado.** `getAllDocuments()` quedó libre de texto: no hidrata.
  Su único llamador que mostraba el texto era el visor de chunks
  (`rag:get-chunks`), que hidrataba el índice entero — 237.920 filas, ~200 MB de
  strings por invocación — para mostrar una pantalla. Ahora pagina:
  `getDocumentPage(offset, limit)` aplica el filtro de elegibilidad sobre el
  corpus completo, recorta, y recién ahí hidrata, sobre copias superficiales
  para que `hydrateContent` no vuelva a dejar el texto residente en el índice.
  El techo de página son 500 filas y lo impone el proceso principal. El orden es
  por `id` y no por orden de inserción del `Map`, memoizado por revisión del
  corpus, para que dos páginas consecutivas coincidan; la página informa esa
  revisión y el visor avisa cuando el índice cambió mientras se paginaba.

Resultado esperado: ~206 MB menos. Con C, deja el total en el rango del giga.

**Riesgo.** Un consumidor que lea `.content` sin pasar por el camino de
hidratación recibe un string vacío en silencio. Mitigación: el campo no se deja
como `string` vacío sino ausente (`content?: string`), para que TypeScript
marque cada lectura y obligue a decidir. La compilación es la red.

### B — Mover el store a un `utilityProcess`

Con C medido, B deja de ser opcional: es el único de los tres que baja el
proceso principal al rango del giga. Los 977 MB de vectores tienen que dejar de
estar ahí, y ningún ajuste del cargador los hace más chicos.

No baja el total de memoria de la máquina — mueve el giga de proceso. Lo que
compra, además del objetivo: el store se reinicia sin reiniciar la app, y un
OOM del índice no se lleva puesta la ventana.

- El store vive en un `utilityProcess` de Electron, se habla por `MessagePort`.
- **Rompe interfaces**: `getChunkNeighbors()`, `getDocumentCount()`,
  `getEligibleDocumentCount()`, `getEligibleMeetingCount()`, `getMeetingCount()`,
  `dropByRecordingFromMemory()`, `isCacheBacked()`, `getAllDocuments()` y
  `getDocumentPage()` son síncronos hoy y pasan a ser `Promise`. Toca los 13
  archivos consumidores. `getDocumentPage()` es el que mejor cruza el límite:
  devuelve una página acotada en vez del corpus entero.
- Los vectores viajan como `SharedArrayBuffer` para no duplicarlos al cruzar
  el límite de proceso.

## Testing

- Unit sobre `blobToEmbedding` y el nuevo cargador contiguo: que una fila
  corrupta siga sin romper la carga entera (comportamiento actual, línea 83).
- Test de partición: que `search()` siga filtrando por el provider activo.
  Existe `vector-store-partitions.test.ts` y no debe cambiar de resultado.
- Regresión de memoria: `apps/electron/scripts/perf/capture.cjs` ya mide el
  boot. Agregar un umbral de `process.memoryUsage()` del proceso principal
  después de `initialize()`, para que un futuro cambio que reintroduzca copias
  por fila falle en CI en vez de aparecer seis meses después.
- Verificación real: abrir la app contra la base de 237.920 chunks y medir
  `PrivateMemorySize64` del proceso principal. No alcanza con los unit tests.

## Criterio de éxito

Proceso principal por debajo de **1,5 GB comprometidos** con la app abierta,
la partición activa cargada y una búsqueda ejecutada. Hoy: 8,47 GB.
