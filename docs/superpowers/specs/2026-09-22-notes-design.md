# Notas: escribirlas acá en vez del notepad, y que sirvan después

Fecha: 2026-09-22
Estado: spec aprobado, en implementación
Feature 4 de 4 de la cola del 22-sep. PR propio, revisión adversarial antes del merge.

## El pedido

Sebastián, 22-sep: "suelo tomar notas en notepad. Sería mucho más útil la opción
de tomar notas acá, con ayuda de IA para categorizarlas, cruzarlas con otras
notas o conocimiento, resumirlas, o incluso asociarlas con reuniones, ya sea que
están ocurriendo mientras graba, o luego a posteriori."

Cuatro verbos: categorizar, cruzar, resumir, asociar. Y una condición que los
ordena: las notas tienen que servir **después**, cuando ya nadie se acuerda de
haberlas escrito.

## Por qué el notepad gana hoy

El notepad abre en menos de un segundo y no pregunta nada. Cualquier cosa que
pida elegir una carpeta, un título o una reunión antes de dejar escribir pierde
contra eso. Entonces la regla del diseño: **una nota nueva es un cursor
parpadeando y nada más.** Título, categoría, resumen y vínculos los pone la IA
después, y todos se pueden corregir.

## Lo que ya existe y no hay que construir

Medido en el código antes de escribir esto:

| Pieza | Estado |
|---|---|
| Búsqueda semántica | **existe**: `vector_embeddings` ya tiene `source_type` y `capture_id`, así que una nota se indexa al lado de los transcripts y la busca el mismo RAG |
| Embeddings locales | **existe**: `local-embedder-runtime.ts`, en su propio proceso |
| Llamadas de IA | **existe**: los brains (`gemini-api-brain.ts` y compañía) |
| Reuniones y grabaciones | **existen**: `meetings`, `recordings`, y la correlación por tiempo |
| Notas por proyecto | **existe** `project_notes`, pero es otra cosa: un ítem de seguimiento colgado de un proyecto, sin contenido largo ni IA |

Lo que falta es la nota como objeto propio, y la superficie para escribirla.

## El diseño

### 1. La tabla

Una tabla `notes`, no una fila de `knowledge_captures`. Un capture es audio: tiene
`audio_sources`, transcripts, diarización, calidad. Una nota no tiene nada de eso,
y meterla ahí obligaría a que cada consulta de la biblioteca filtre las filas que
no son grabaciones. Se paga una tabla y se ahorra esa condición en todos lados.

```
notes
  id                TEXT PRIMARY KEY
  title             TEXT          -- del usuario si lo escribió; si no, el sugerido
  suggested_title   TEXT          -- de la IA, nunca pisa al del usuario
  content           TEXT NOT NULL -- markdown, tal como se tipeó
  summary           TEXT          -- de la IA
  category          TEXT          -- de la IA, corregible
  category_source   TEXT          -- 'ai' | 'user', para no pisar una corrección
  tags              TEXT          -- JSON array
  meeting_id        TEXT          -- nullable
  recording_id      TEXT          -- nullable
  link_source       TEXT          -- 'live' | 'user' | 'suggested'
  ai_status         TEXT          -- 'none' | 'pending' | 'ready' | 'failed'
  ai_error          TEXT
  created_at, updated_at, deleted_at
```

`category_source` y `suggested_title` repiten deliberadamente la forma que ya usan
`knowledge_captures.quality_source` y `user_title`: un reanálisis refresca lo que
puso la IA y jamás toca lo que escribió el usuario. Esa regla ya se rompió una vez
en esta app y costó una revisión adversarial entera; se copia en vez de reinventar.

### 2. Escribir

Una superficie nueva, `apps/electron/src/features/notes/`. Lista a la izquierda,
editor a la derecha, y un atajo global que abre una nota nueva con el foco ya en
el cuerpo.

- **Guardado solo.** A los 800 ms de dejar de tipear, y al salir. Nada de botón
  Guardar: el notepad tampoco lo tiene y perder una nota por no apretarlo sería
  peor que cualquier cosa que este feature agregue.
- **Markdown crudo.** Se tipea markdown y se ve markdown. Un editor enriquecido
  es otro proyecto y pelea con pegar texto de cualquier lado.
- **El título es opcional.** La primera línea se muestra como título mientras no
  haya uno, exactamente como hace la lista de la biblioteca con el nombre de
  archivo.

### 3. Asociar con lo que está pasando

Si hay una grabación en curso cuando se crea la nota, la nota queda atada a esa
grabación con `link_source='live'`, sin preguntar. Es el caso que el pedido nombra
primero y el único que no se puede reconstruir después: en el momento se sabe, más
tarde hay que adivinar.

A posteriori hay dos caminos, los dos explícitos:

| Camino | Qué hace |
|---|---|
| Elegir la reunión a mano | `link_source='user'`, gana siempre |
| Aceptar una sugerencia | `link_source='suggested'` |

Las sugerencias salen de dos señales que ya están: la reunión del calendario que
cubre el momento en que se escribió la nota, y el parecido semántico entre la nota
y el transcript. Se muestran con el motivo escrito ("se escribió durante esta
reunión", "menciona lo mismo que este transcript"), nunca como un vínculo ya hecho.

### 4. Lo que hace la IA, y cuándo

Cuatro acciones, todas sobre una nota que ya está guardada, ninguna bloqueando el
tipeo:

| Acción | Qué produce |
|---|---|
| Categorizar | `category` y `tags` |
| Resumir | `summary` y `suggested_title` |
| Cruzar | una lista de notas, transcripts y reuniones parecidas |
| Asociar | reuniones candidatas, con el motivo |

Las dos primeras corren juntas en una sola llamada, porque pedir categoría y
resumen por separado es pagar dos veces por leer el mismo texto.

**Cuándo corren.** No con cada tecla y no con cada guardado: una nota que se edita
diez veces en dos minutos pagaría diez llamadas. Corren cuando la nota estuvo
quieta 30 segundos y cambió de verdad desde el último análisis, o cuando el
usuario aprieta el botón. Si no hay proveedor de IA configurado, la nota funciona
igual y los campos quedan vacíos: escribir no depende de la nube.

### 5. Cruzar

Cada nota guardada se indexa en `vector_embeddings` con `source_type='note'`.
Eso le da dos cosas de una:

- el panel "Relacionado" de la nota, que busca contra notas y transcripts;
- el chat y el RAG de siempre, que desde ahora encuentran las notas sin que haya
  que tocarlos.

El borrado de una nota borra sus vectores en la misma transacción. Un vector
huérfano haría que el chat cite una nota que ya no existe, que es peor que no
encontrarla.

## Lo que no entra

- **Editor enriquecido, imágenes pegadas, adjuntos.** Markdown y texto.
- **Carpetas y jerarquías.** Categorías y tags, que es lo que el pedido nombra.
- **Notas colaborativas o sincronizadas.** Todo local, como el resto de la app.
- **Convertir `project_notes` en esto.** Son dos cosas distintas y fusionarlas es
  una migración de datos que este feature no necesita.
- **Editar el transcript desde la nota.** Se vinculan, no se mezclan.

## Testing

- La tabla: crear, editar, borrar (blando), y que el borrado se lleve los vectores.
- Precedencia: el título del usuario le gana al sugerido; una categoría corregida
  a mano sobrevive a un reanálisis; `category_source` lo decide.
- Guardado solo: dos ediciones seguidas escriben una vez, salir escribe siempre.
- Atado en vivo: con grabación en curso queda `link_source='live'`; sin grabación
  queda sin vínculo.
- Sugerencias: se muestran con motivo y no se aplican solas.
- IA: no corre con cada guardado, corre a los 30 s de quietud, no corre dos veces
  sobre el mismo texto, y una falla deja `ai_status='failed'` con el motivo sin
  perder la nota.
- Sin proveedor de IA: se puede escribir, guardar, buscar por texto y vincular a
  mano.
- Indexado: una nota guardada aparece en la búsqueda semántica y en el RAG.

## Criterio de éxito

Abrir una nota es igual de rápido que abrir el notepad. Una nota escrita durante
una reunión aparece después colgada de esa reunión sin que nadie la haya
vinculado. Y buscar algo en el chat encuentra lo que se escribió a mano igual que
lo que se dijo en voz alta.
