# Grabaciones sin reunión: título sugerido por defecto y renombre

Fecha: 2026-09-22
Estado: spec aprobado, en implementación
Feature 2 de 4 de la cola del 22-sep. PR propio, revisión adversarial antes del merge.

## El pedido

Sebastián, 22-sep: "Recordings que no están asociadas a ninguna meeting, debo
poder renombrarlas, y el sistema debería sugerir un título también y desplegarlo
por defecto, con la opción en setting para cambiarlo."

Son 945 grabaciones de 2.131 sin reunión asociada. Hoy la lista les muestra el
nombre de archivo: `2026Sep21-170242-Rec32.hda`.

## Lo que ya existe (y no hay que construir)

Medido antes de escribir esto:

| Pieza | Estado |
|---|---|
| Título sugerido por IA | **existe**: `knowledge_captures.title`, poblado en 938 de las 945 |
| Título del usuario | **existe**: `knowledge_captures.user_title`, columna y migración |
| Guardarlo | **existe**: `knowledge:update` acepta `userTitle` y lo normaliza a `null` si queda vacío |
| Leerlo | **existe**: `userTitle` viaja hasta `UnifiedRecording` |
| Renombrar en el lector | **existe**: `SourceReader.tsx` tiene el editor de título |

Lo que falta es lo que se ve: la lista no usa nada de eso.

## La decisión que este cambio revierte

`getDisplayTitle` es explícito, y hay que decirlo antes de cambiarlo:

```ts
 * The immutable filename identifies an unassigned source. Once a calendar event
 * is assigned, its official subject becomes the source title. User/AI content
 * titles remain independent descriptive metadata and never replace either one.
```

La regla era: el título de la fila es **identidad de la fuente** (nombre de
archivo, o asunto del evento), nunca contenido. Tenía su lógica: el nombre de
archivo es inmutable y casa con lo que hay en el disco y en el dispositivo.

Contra eso: 945 filas que dicen `2026Sep21-170242-Rec32.hda` no le dicen nada a
nadie, y el título que sí describe la grabación ya está calculado y guardado, a
un join de distancia. La identidad se conserva mostrándola al lado, no
ocupando la línea principal.

El cambio es deliberado y del dueño del producto. Queda anotado en el propio
`getDisplayTitle` para que la próxima persona que lo lea no lo "arregle" de
vuelta.

## El diseño

### 1. Precedencia nueva, sólo cuando no hay reunión

`getDisplayTitle` pasa a resolver así:

| Orden | Fuente | `source` |
|---|---|---|
| 1 | asunto del evento de calendario | `meeting-subject` |
| 2 | `userTitle` | `user-title` |
| 3 | título sugerido por IA (`capture.title`) | `suggested` |
| 4 | nombre de archivo | `filename` |

El asunto del evento sigue primero: cuando hay reunión, manda el calendario, y
eso no se toca. Los pasos 2 y 3 son nuevos y sólo pueden aplicar a las
grabaciones sin reunión, que es exactamente el pedido.

`source` ya lo consume `SourceRow` para decidir si muestra el nombre de archivo
como texto secundario; con la precedencia nueva, una fila titulada por IA o por
el usuario muestra el archivo debajo. **La identidad no se pierde, se corre de
lugar.**

### 2. El ajuste

`ui.unassignedTitleSource`, en Settings → Transcription, tres valores:

- `suggested` (default): la precedencia de arriba.
- `filename`: el comportamiento actual, para quien quiera la identidad primero.

Dos valores, no tres: "usuario" no es una opción separada porque un título que
el usuario escribió a mano gana siempre. Si alguien pone `filename`, su propio
título sigue apareciendo — lo que apaga es la **sugerencia de la IA**, que es lo
único que él no eligió.

### 3. Renombrar desde la lista

El editor del lector ya existe y escribe `userTitle`. Falta llegar a él sin
abrir el lector: **doble clic sobre el título de la fila** lo vuelve un input,
Enter guarda, Escape cancela, vacío borra el `user_title` y vuelve a la
sugerencia. Misma llamada IPC que ya usa el lector, sin backend nuevo.

Una grabación sin `knowledgeCaptureId` no tiene dónde guardar el título: en ese
caso el renombre queda deshabilitado con el motivo en el tooltip, en vez de
fallar al guardar.

### 4. Las 7 sin sugerencia

938 de 945 ya tienen título sugerido; 7 no. No se genera nada en masa por
detrás: esas 7 muestran el nombre de archivo, que es la respuesta correcta
cuando no hay nada mejor. La sugerencia se produce cuando esa grabación se
transcribe o se re-analiza, que es el camino que ya la produce para las otras
938.

## Lo que no entra

- **Renombrar el archivo en disco.** `filename` es identidad y se queda quieto.
  Esto renombra lo que se muestra, no lo que está en el disco ni en el
  dispositivo.
- **Regenerar sugerencias en masa** para la biblioteca entera.
- **Tocar el título cuando hay reunión.** El asunto del calendario sigue mandando.

## Testing

- `getDisplayTitle`: las cuatro precedencias, con y sin reunión, con el ajuste en
  `suggested` y en `filename`; que `userTitle` gane incluso con el ajuste en
  `filename`; que espacios en blanco no cuenten como título.
- `source` correcto en cada caso, porque de eso depende que la fila muestre el
  nombre de archivo como secundario.
- Renombre en la fila: guarda, cancela con Escape, vacío borra, y queda
  deshabilitado sin `knowledgeCaptureId`.
- Que el ajuste persista y se lea al arrancar.

## Criterio de éxito

La biblioteca deja de mostrar 945 nombres de archivo. Cada una de esas filas
muestra el título que la describe, el nombre de archivo sigue visible debajo, el
doble clic renombra, y quien prefiera el comportamiento viejo lo tiene en
Settings.
