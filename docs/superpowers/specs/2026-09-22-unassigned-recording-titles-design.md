# Grabaciones sin reunión: título sugerido por defecto y renombre

Fecha: 2026-09-22
Estado: construido y mergeado en `main` ([PR #8](https://github.com/sgeraldes/hidock-next-2/pull/8)).
**Cambio del 25-sep (Sebastián):** el nombre de archivo sale de la lista por completo: ni título de
respaldo, ni tooltip, ni fila expandida, ni opción en Settings. Solo aparece en la sección Metadata del
lector ("el filename no es importante, fecha y hora ya se extraen; sirve para encontrarlo en el
dispositivo"). Sin título, una grabación se llama "Recording, <fecha y hora>"; un documento, imagen o
nota importados conservan su nombre de archivo, que eligió una persona. La búsqueda sigue encontrando
por nombre de archivo. La opción `ui.unassignedTitleSource` ya no se lee.

Feature 2 de 4 de la cola del 22-sep. El QA del 22-sep lo leyó contra el código y no
encontró ninguna diferencia de comportamiento; lo único que corrigió fue un número.

## El pedido

Sebastián, 22-sep: "Recordings que no están asociadas a ninguna meeting, debo
poder renombrarlas, y el sistema debería sugerir un título también y desplegarlo
por defecto, con la opción en setting para cambiarlo."

Son 945 grabaciones de **2.129 vivas** sin reunión asociada. Hoy la lista les
muestra el nombre de archivo: `2026Sep21-170242-Rec32.hda`. (La tabla `recordings`
tiene 2.131 filas; dos están borradas. El número que importa es el de las vivas, y
este documento decía 2.131 en la prosa y 2.129 en la tabla de mediciones.)

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

Contra eso: 945 filas de 2.129 que dicen `2026Sep21-170242-Rec32.hda` no le dicen
nada a nadie, y el título que sí describe la grabación ya está calculado y guardado, a
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

`source` ya lo consume `SourceRow` para decidir dónde queda el nombre de
archivo. **La identidad no se pierde, se corre de lugar** — y conviene ser
exacto sobre a dónde, porque la primera redacción de este spec decía "lo
muestra debajo" y eso no es lo que se construyó:

| Dónde | Qué pasa con el nombre de archivo |
|---|---|
| Fila de la lista | tooltip de la segunda línea (`title=`), al pasar el mouse |
| Lector | campo **Filename** explícito, visible, cuando el título no es el archivo |
| Búsqueda | `buildSearchCorpus` lo indexa aparte del título, siempre |

No va como texto siempre visible en la fila: la fila compacta mide 48px fijos
—de eso depende la aritmética del virtualizador— y su única línea secundaria es
fecha · hora · duración. Si en el uso real el tooltip no alcanza, la decisión de
darle una línea propia es de producto y cambia el alto de la fila.

El mismo título y la misma preferencia valen para la vista de tarjetas
(`SourceCard`), que antes se titulaba sola con `recording.title || filename`.

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

Tres reglas que salieron de la revisión adversarial y son parte del contrato:

- `knowledge:update` **informa** el fallo en el resultado, no lo tira. Hay que
  mirar `result.success`; confiar en la ausencia de excepción mostraba un
  renombre que nunca se escribió y desaparecía al refrescar.
- Abrir el editor y confirmarlo **sin tocarlo** no escribe nada. Si no, un doble
  clic al pasar más un clic afuera estampaba la sugerencia de la IA en
  `user_title`, que le gana a la preferencia `filename` y sobrevive a un
  re-análisis: queda fijada una elección que el usuario nunca hizo.
- El clic simple sobre el título espera la ventana del doble clic antes de abrir
  el lector. Sin eso el renombre abría igual el lector y borraba la selección
  múltiple, que es justo el viaje que esta función existe para evitar.

### 4. Las 7 sin sugerencia

938 de 945 ya tienen título sugerido; 7 no. Medido contra la base real el
22-sep: esas 7 son exactamente las que **no tienen fila en
`knowledge_captures`**, así que son también las 7 que no se pueden renombrar a
mano — no hay dónde guardar el título. El tooltip lo dice. Se destraba solo
cuando se transcriben. No se genera nada en masa por
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

## Lo medido contra la base (22-sep, sólo lectura)

| Consulta | Resultado |
|---|---|
| grabaciones vivas | 2.129 |
| sin reunión | 945 |
| sin reunión con título sugerido | 938 |
| sin reunión sin fila de captura | 7 |
| `title` vacío, nulo o en blanco | 0 |
| `user_title` ya poblado | 0 |
| títulos sugeridos distintos entre los 938 | 924 |

Los 14 repetidos son mayormente pruebas de audio ("Prueba de Asistente Virtual
Seguros Bolívar" aparece 6 veces). Esas filas se siguen distinguiendo por la
segunda línea, que lleva fecha, hora y duración.

## Criterio de éxito

La biblioteca deja de mostrar 945 nombres de archivo. Cada una de esas filas
muestra el título que la describe, el nombre de archivo sigue visible debajo, el
doble clic renombra, y quien prefiera el comportamiento viejo lo tiene en
Settings.
