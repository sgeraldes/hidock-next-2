# Lector de grabaciones: una sola columna con secciones que se fijan arriba

Fecha: 2026-09-22
Estado: la primera parte entró a `main` con el PR #18. La segunda (compactar
los controles de sección) está descrita en "Segundo paso", al final, y va en
el PR #26.

## El pedido

Sebastián, 22-sep:

> Quiero cambiar el layout del visor de grabaciones. Hoy son dos secciones, la de
> arriba con metadata y player, y la de abajo con resumen y transcripción. Las
> quiero unificadas, una sola sección larga. Que puedas scrollear y tener
> secciones que se pegan arriba, en vez de dos secciones. Hoy tiene un layout que
> podés ajustar, o minimizar cada sección. Eso lo quiero seguir teniendo, pero
> quiero que se auto minimicen y se peguen arriba a medida que scrolleamos. Quiero
> ver que al scrollear, las secciones se auto compactan en una animación fluida.
>
> También necesitamos que las acciones, decisiones y otros temas importantes de la
> conversación, que hoy son parte del gráfico expandido del player, sean su propia
> sección. También scrolleable, minimizada arriba a una parte chica.
>
> Primero mover la transcripción a la misma sección que el resto. No perder las
> opciones de layout.

## El defecto

`SourceReader.tsx` parte el lector en dos paneles con un handle de redimensión
entre ellos, y cada panel tiene su propio scroll:

| Panel | Contenido | Alto por defecto | Scroll |
|---|---|---|---|
| superior (`reader-compact-header`) | título, meta, CTAs, metadata, player | 64 % | propio |
| inferior (`reader-scroll-body`) | resumen, transcripción | 36 % | propio |

Tres consecuencias medibles, leídas del código antes de escribir esto:

1. Leer la transcripción de corrido obliga a arrastrar el handle o a maximizar la
   sección, porque el 36 % por defecto son unas pocas líneas visibles.
2. El player, aunque esté expandido, come 64 % del alto del lector aun cuando el
   usuario está leyendo la transcripción y no lo está mirando.
3. La lista de acciones y decisiones vive dentro de `FullTimeline`, en
   `WaveformPlayer.tsx`, con `max-h-40` y scroll interno. Solo existe en el modo
   `full` del player: minimizar el player la hace desaparecer, y es contenido que
   no tiene nada que ver con el transporte de audio.

## Lo que ya existe y no hay que construir

| Pieza | Estado |
|---|---|
| Estados explícitos por sección | **existe**: `ReaderSectionMode = expanded \| compact \| docked \| hidden` |
| Persistencia de esos estados | **existe**: `readerSectionModes` en el store persistido |
| Maximizar / restaurar una sección | **existe**: `maximizeReaderSection`, `restoreReaderSection` |
| Ocultar y volver a mostrar | **existe**: `HiddenReaderSections` |
| Menú de layout por sección | **existe**: `ReaderSectionControls` |
| Acciones y decisiones como datos | **existe**: `TimelineEvent` + `TimelineEventDetail`, con `refId` a las filas `action_items` / `decisions` |
| Edición en línea de esos items | **existe**: `onEventUpdate` persiste contenido y estado |

Nada de esto se rehace. El cambio es dónde se renderiza y cómo se comporta al
scrollear.

## La decisión que este cambio revierte

`useLibraryStore.ts` dice hoy, sobre `readerSectionModes`:

```ts
// Reader workspace layout. Each source section has an explicit state; none of
// these change implicitly when the user scrolls.
```

Y `waveformPinned` sobrevive solo por compatibilidad, con esta nota:

```ts
// Legacy preference retained for persisted-store compatibility. New reader UI
// uses readerSectionModes.player instead of scroll-driven pinning.
```

La regla era que el scroll no toca el layout. Tenía su motivo: la versión
anterior fijaba el player por scroll, el resultado saltaba, y la respuesta fue
sacar el scroll de la ecuación y dejar que el usuario eligiera explícitamente.

El dueño del producto la revierte el 22-sep: quiere el fijado por scroll de
vuelta, con compactación animada. Lo que hace que la reversión no repita el
problema anterior está en la sección "Dos capas de estado": el scroll produce una
**presentación**, nunca escribe el estado elegido. El comentario del store se
reescribe con esta explicación, igual que `getDisplayTitle.ts` dejó anotada la
suya el mismo día.

## El diseño

### 1. Una sola columna

Desaparecen el `ResizablePanelGroup` vertical, los dos `ResizablePanel` y el
handle. Queda un único contenedor con scroll, que conserva el `data-testid`
`reader-scroll-body` porque sigue siendo el elemento scrolleable del lector.

Orden de la columna:

| # | Bloque | ¿Sección con estado? |
|---|---|---|
| 0 | título, tira de meta, CTAs | no, es el encabezado del lector |
| 1 | player | sí (`player`) |
| 2 | metadata | sí (`metadata`) |
| 3 | acciones y decisiones | sí (`moments`, nueva) |
| 4 | resumen | sí (`summary`) |
| 5 | transcripción | sí (`transcript`) |

La metadata hoy está partida en dos: el encabezado y los campos de identidad van
arriba del player, y la reunión vinculada y "More metadata" van abajo. Una
sección partida no se puede fijar como una unidad, así que los dos pedazos se
juntan en uno solo, debajo del player. Los `data-testid` de ambos pedazos
(`source-identity-fields`, `linked-meeting-card`, `reader-more-metadata`) se
conservan.

`readerVerticalSizes` se queda en el store y en `partialize`, sin lector. Un
store persistido viejo la trae y no debe romper el rehidratado, exactamente el
trato que recibió `waveformPinned`. Queda comentada como tal.

### 2. Dos capas de estado

| Capa | Quién la escribe | Dónde vive | ¿Persiste? |
|---|---|---|---|
| modo (`expanded`/`compact`/`docked`/`hidden`) | el usuario, por el menú de layout | `readerSectionModes` en el store | sí |
| fijado (`pinned`/`en flujo`) | la posición del scroll | estado local de `SourceReader` | no |

El scroll nunca llama a `setReaderSectionMode`. Una sección que el usuario puso
en `compact` sigue en `compact` al volver arriba, y una en `hidden` no reaparece
nunca por scrollear.

Esta separación es la misma que el repo ya sostiene en cuatro lugares:
`userTitle` contra `title`, `quality_source`, `category_source`, y
`liveMicChannel` contra `liveMicChannelMeasured`. En todos, lo que el usuario
eligió y lo que el sistema dedujo se guardan aparte.

La presentación efectiva sale de las dos capas:

| Modo persistido | En flujo | Fijado |
|---|---|---|
| `expanded` | tira + cuerpo | tira pegada arriba, el cuerpo sigue scrolleando debajo |
| `compact` | tira | tira pegada arriba |
| `docked` | tira pegada arriba (elección explícita) | igual |
| `hidden` | no se renderiza | no se renderiza |

### 3. Qué hace el fijado, y qué no hace

Fijar **no** colapsa el cuerpo de la sección. Fija la tira de encabezado arriba y
deja que el cuerpo siga scrolleando debajo de ella. Lo que el usuario ve mientras
baja es que de la sección va quedando solo su tira, que es la compactación que
pidió, sin que nada salte.

La alternativa descartada, y por qué: colapsar el cuerpo al fijar borra de golpe
el alto que ese cuerpo ocupaba. El navegador recorta `scrollTop`, la página
salta hacia arriba, el centinela de la sección vuelve a entrar en vista, la
sección se desfija, el cuerpo reaparece y el ciclo se repite. Es el mismo
oscilar que llevó a prohibir el fijado por scroll la primera vez. Reservar el
alto con un espaciador lo evita, a cambio de dejar un hueco vacío del tamaño del
cuerpo, que es justo el desperdicio de espacio del que se queja el pedido.

Con la tira siempre del mismo alto, fijado y desfijado no cambian el flujo del
documento, y no hay salto posible por construcción.

Minimizar sí esconde el cuerpo, con una excepción: el player. Su cuerpo ya tiene
una presentación compacta propia (el gráfico se vuelve una pastilla), y
esconderlo dejaría un player minimizado sin botón de Play. `ReaderSection` lo
recibía como `keepBodyWhenCompact`; desde el segundo paso es `headerless`, que
además quita la tira (ver "Segundo paso"). Es el comportamiento que ya tenía y que las
pruebas existentes afirman.

### 4. El presupuesto de la pila

Cinco tiras apiladas arriba se comen el lector. El presupuesto:

```
PINNED_STRIP_H     = 32   // px, alto de la tira, fijo en flujo y fijada
MAX_PINNED_FRACTION = 0.3 // la pila nunca ocupa más del 30% del alto del lector
maxPinned = clamp(floor(alto_del_lector * 0.3 / 32), 1, 5)
```

Las secciones se fijan en orden de documento hasta agotar `maxPinned`. Las que
sobran no se fijan: scrollean y se van, que es preferible a una pila que deja
sin lugar al texto.

De dónde salen los números:

| Cantidad | Valor | Origen |
|---|---|---|
| alto de la tira | 32 px | fila de control con un `Button size="sm"` (`h-8`) adentro y sin padding vertical extra |
| pila completa | 160 px | 5 tiras |
| alto mínimo del lector para las 5 | 534 px | 160 / 0,3 |
| a 400 px de lector | 3 tiras | floor(400 × 0,3 / 32) |

El 30 % es el reparto: el encabezado fijo puede quedarse con hasta un tercio de
lo visible y deja dos tercios para el contenido que se está leyendo. El piso de
1 evita que un lector muy bajo deje la función inservible, y el techo de 5 es la
cantidad de secciones que existen.

El alto del lector se mide con un `ResizeObserver` sobre el contenedor con
scroll, no en el manejador de scroll. `maxPinned` se recalcula al cambiar el
tamaño de la ventana o del panel, no en cada frame.

### 5. La tira baja de 36 px a 32 px, adelantado del PR siguiente

`ReaderSectionControls` usa hoy `min-h-9` (36 px). Con 36, la pila de cinco mide
180 px y necesita un lector de 600 px para caber entera dentro del 30 %. Con 32
necesita 534 px. El presupuesto de la pila es la razón por la que este pedazo del
rediseño de espacio se adelanta.

Además, `min-h-9` es un mínimo, y un mínimo hace que el alto de la tira dependa
de su contenido. La aritmética del `top` de cada sección fijada
(`índice × 32 px`) necesita un alto constante, así que la tira pasa a alto fijo.

### 6. Acciones y decisiones como sección propia

La lista sale de `FullTimeline` (`WaveformPlayer.tsx`) a un componente propio,
`TimelineEventList.tsx`, y el lector la renderiza como la sección `moments`, con
los mismos cuatro estados y el mismo menú de layout que las demás.

Qué se conserva sin cambios: numeración, colores e íconos por tipo, texto
completo con wrap, panel de detalle desplegable, chip de timestamp que busca en
el audio, edición en línea de los items editables, y marcar una acción como
completada.

Qué cambia:

| Antes | Ahora |
|---|---|
| solo visible con el player en modo `full` | visible con el player en cualquier modo, incluso oculto |
| `max-h-40` con scroll interno | sin tope: scrollea con la columna, como el resto |
| lista filtrada por `timeSec <= duración` | la lista muestra todos los eventos; el filtro por duración queda donde sirve, en los marcadores del gráfico |

El último punto es un arreglo colateral: hoy, si la duración no se conoce todavía
(`duration <= 0`), `markers` queda vacío y la lista de acciones desaparece junto
con los marcadores. Como sección propia ya no depende del eje de tiempo.

Los colores y los íconos por tipo (`EVENT_KIND_COLOR`, `EVENT_KIND_ICON`) se
mudan a `apps/electron/src/features/library/utils/timelineEventKinds.ts`. Vivían
dentro de `WaveformPlayer.tsx` porque la lista también vivía ahí; al salir la
lista y seguir importándolos de ahí, cualquier prueba que mockea el player
rompía la lista. Un valor que usan dos componentes va en un módulo que no es de
ninguno de los dos. Esto lo encontró una prueba existente, no una revisión.

Los marcadores numerados se quedan en la curva del gráfico. El resaltado cruzado
entre marcador y fila sigue funcionando: `activeEventId` sube a `SourceReader`,
que ya es el dueño de `handleTimelineEventClick`, y baja a los dos. El prop
`activeEventId` de `WaveformPlayer` ya existe para esto.

### 7. Animación

La tira cambia de aspecto al fijarse: fondo, sombra y separador. El alto no
cambia, así que la transición no mueve nada de lugar.

```
transition: background-color, box-shadow, border-color
duración:   180 ms
easing:     ease-out
```

Se dispara con `motion-safe:`, la variante de Tailwind que el repo ya usa en
`ReaderPlayer` para el morph del player, así que `prefers-reduced-motion:
reduce` deja el cambio instantáneo.

Nada de esto corre en el manejador de scroll. El lector no registra ningún
listener de scroll. El fijado lo detecta un `IntersectionObserver` por sección
sobre un centinela absoluto de 12 px de alto anclado al borde superior de la
sección, con `root` en el contenedor con scroll y `rootMargin` superior negativo
igual al `top` donde esa sección se pega:

| Lectura del observer | Resultado |
|---|---|
| `intersectionRatio >= 1` (centinela entero a la vista) | en flujo |
| `!isIntersecting` (centinela entero pasado) | fijada |
| entre ambas | se conserva el estado anterior |

Esos 12 px son la histéresis. El estado solo cambia cuando el cruce es completo,
así que un temblor de scroll de menos de 12 px alrededor del borde no puede
alternar el estado. `IntersectionObserver` entrega sus callbacks fuera del
camino del scroll, agrupados por el navegador, y son dos por sección en toda una
pasada de scroll, no uno por frame.

Lo medido: el centinela es absoluto (`position: absolute`, `pointer-events:
none`), no participa del flujo y no agrega alto; la tira mide lo mismo fijada que
en flujo; el cuerpo no cambia de alto al fijar. Las tres cosas juntas dan cero
reflow atribuible al fijado. Lo que no está medido está en "Lo que no se pudo
verificar".

### 8. Store

| Cambio | Detalle |
|---|---|
| `ReaderSectionId` | suma `'moments'` |
| `readerSectionModes` | suma `moments: 'expanded'` en el default y en `resetReaderLayout` |
| `readerVerticalSizes` | se queda, sin lector, comentada como compatibilidad |
| persistencia | `version: 1` + `migrate` que completa las secciones ausentes en un store guardado por la versión anterior |

El `migrate` es necesario porque el merge por defecto de `zustand/persist` es
superficial: un `readerSectionModes` guardado con cuatro claves reemplaza al
default de cinco y deja `moments` en `undefined`. El lector además lee cada modo
con `?? 'expanded'`, porque los tests montan el store con `setState` parcial y
ese camino no pasa por `migrate`.

## Lo que no entra

- El rediseño de espacio del encabezado (ver la última sección). Lo único que se
  adelanta es el alto de la tira, y por la razón dada en el punto 5.
- Fijar el título y la tira de meta del lector. Scrollean y se van, como hoy.
- Cambiar el contenido de resumen, transcripción o metadata.
- Cambiar cómo se extraen o se guardan las acciones y decisiones.
- Guardar la posición de scroll del lector entre grabaciones.

## Pruebas

Archivo nuevo: `SourceReader.stickySections.test.tsx`, en jsdom, con
`IntersectionObserver` sustituido por un doble que expone sus callbacks para
poder simular los cruces.

| Caso | Qué prueba |
|---|---|
| una sola columna | existe un solo `reader-scroll-body` y no existe `reader-vertical-resize-handle` |
| la transcripción vive en la columna | `reader-transcript-content` está dentro de `reader-scroll-body` |
| fijar no escribe el modo | tras cruzar el centinela del player, `readerSectionModes.player` sigue en `expanded` y la tira tiene `data-pinned="true"` |
| `compact` sobrevive al scroll de vuelta | con el player en `compact`, cruzar hacia adelante y hacia atrás lo deja en `compact` |
| `hidden` sobrevive al scroll | una sección oculta no se renderiza en ningún estado de fijado |
| histéresis | con `intersectionRatio` entre 0 y 1 el estado no cambia |
| presupuesto | con el lector a 400 px solo se fijan las 3 primeras secciones visibles; la cuarta no tiene `position: sticky` |
| el presupuesto cuenta visibles | con una sección oculta, la que sigue hereda su lugar en la pila |
| `docked` es fijado explícito | una sección en `docked` se lee como fijada aunque el centinela esté entero a la vista |
| la sección de acciones | los eventos se renderizan fuera del player, y siguen ahí con el player en `compact` |
| resaltado cruzado | activar una fila la marca como el evento activo, que es lo que lee el gráfico |

En `TimelineEventList.test.tsx`, además de las seis pruebas que se mudaron: la
lista muestra sus filas con la duración desconocida, y dice en palabras que no
hay nada cuando la lista está vacía.

Verificación de las pruebas nuevas: cada una se corrió contra siete mutaciones
deliberadas del código que cubre (quitar la histéresis, ignorar el alto del
lector en el presupuesto, correr el alto de la tira a 36 px, hacer que el fijado
escriba el modo persistido, dejar que una sección oculta ocupe lugar en la pila,
volver a atar la lista al player expandido, borrar el centinela). Las siete
hacen fallar al menos una prueba. La del centinela necesitó una aserción
adicional: como jsdom no tiene layout, esconderlo no cambia nada para el
observer, así que la prueba afirma el contrato del que depende la banda (altura
`SENTINEL_H`, fuera del flujo).

### Dos defectos que encontraron las pruebas, no una revisión

1. **El hook corría después del `return` temprano.** `SourceReader` sale antes de
   tiempo cuando no hay grabación, y `useStickySectionPins` había quedado abajo
   de esa línea. Seleccionar una grabación después de no tener ninguna rompía el
   lector con "Rendered more hooks than during the previous render". Lo levantó
   `Library.trash.test.tsx`, que hace exactamente esa secuencia.
2. **Las secciones que montan tarde no se observaban nunca.** Resumen y
   transcripción no están en el árbol en el primer render de una grabación cuyo
   transcript todavía está cargando. Registraban su centinela después de que el
   efecto ya había corrido, y se quedaban sin observer para toda la vida del
   lector: no se fijaban nunca, en silencio. El efecto ahora depende de una
   versión que se incrementa al montar o desmontar un centinela, y las callbacks
   de ref son estables por sección (una closure nueva por render hace que React
   desmonte y vuelva a montar la ref en cada render, que con esa versión es un
   bucle infinito). Cubierto por una prueba que monta sin transcript y lo agrega
   después.

Cada prueba nueva se verifica rompiendo a propósito el código que cubre,
mirándola fallar, y restaurando.

Se adaptan, sin borrar ni saltear:

| Archivo | Qué cambia y por qué |
|---|---|
| `SourceReader.waveform.test.tsx` | la prueba de maximizar afirmaba que `reader-scroll-body` desaparece; con una sola columna el contenedor siempre existe, así que pasa a afirmar que las demás secciones no se renderizan. "No cambia la presentación al scrollear" **no se toca y sigue en verde**: el fijado mueve la tira, no el player, así que la presentación (`full` / `pill`) sigue dependiendo solamente del modo elegido |
| `WaveformPlayer.test.tsx` | las seis pruebas de la lista de eventos se mudan enteras a `TimelineEventList.test.tsx` junto con la lista. Lo que asertaban sobre las filas no cambia; el seek ahora llega por `onActivate`. La prueba de "apertura en silencio" pasa a afirmar que la lista **no** está en el player |
| `useLibraryStore.test.ts` | los defaults y `resetReaderLayout` incluyen `moments` |
| `Library.test.tsx`, `Library.trash.test.tsx`, `Library.deletePermanent.test.tsx`, `Library.deviceDelete.test.tsx`, `library-a11y.test.tsx`, `library-performance.test.tsx` | los mocks del store suman `moments: 'expanded'` |

## Criterio de éxito

1. Con una grabación transcripta abierta, bajar por la columna muestra sucesivamente
   la tira del player, la de metadata y la de acciones pegadas arriba, y la
   transcripción se lee de corrido sin tocar ningún control.
2. Ninguna secuencia de scroll cambia un valor de `readerSectionModes`.
3. Poner una sección en `compact`, bajar, subir, y encontrarla todavía en
   `compact`.
4. Las acciones y decisiones se ven con el player minimizado.
5. Las cinco secciones conservan expandir, minimizar, fijar, maximizar y ocultar.
6. `npx tsc --noEmit -p tsconfig.web.json` y `npx eslint .` limpios en
   `apps/electron`; los archivos de test tocados en verde.

## Lo que no se pudo verificar

Los skills `design-essence` e `impeccable` piden un mockup renderizado y
capturas a 390 y 1440 px, revisadas por Sebastián, antes de commitear cualquier
cambio visual, y una auditoría visual independiente sobre la app desplegada. Nada
de eso se hizo acá: esta sesión tiene prohibido abrir la app, un preview o
cualquier ventana, porque Sebastián está trabajando en la misma máquina. La
verificación es de jsdom y de tipos.

Queda sin medir contra la app corriendo:

- La fluidez real de la animación a 60 fps.
- El alto real del lector en la ventana de Sebastián, y por lo tanto cuántas
  tiras se fijan en la práctica.
- Si 32 px de tira se ven bien apiladas de a cinco.
- **La histéresis de verdad.** jsdom no tiene layout, así que las pruebas
  ejercitan la lógica de los umbrales (`intersectionRatio`), no los píxeles. Que
  12 px alcancen para que un temblor de scroll no haga parpadear una tira es una
  decisión que sólo confirma el navegador.
- Que ningún ancestro de una sección tenga `overflow` o `transform`, que es lo
  único que rompe `position: sticky`. Se revisó leyendo el árbol de clases; no
  se vio renderizado.

La aprobación visual queda pendiente.

`papel-y-tinta` no se aplica: es el sistema de los productos internos de dfx5
(Nexo, Academy, Delivery Central, Sales, EDF), y HiDock tiene su propio sistema
de tokens sobre shadcn.

## Segundo paso: controles compactos (rama `feat/reader-compaction`)

### El pedido

Sebastián, 22-sep, sobre el player:

> the player doesn't need a title above it saying 'Player', not the 'minimized'
> label. The Layout button can be just a button with no text, and at the same
> level of the player, not in a title, but next to the 1x speed selector,
> outside of the player itself. And in order to expand that section, you can
> unscroll, but also have an icon next to layout to minimize or unminimize and
> maximize, or even hide.

Y sobre acciones y decisiones minimizada: ocupar arriba una parte chica, sin el
espacio desperdiciado que tenía el estado minimizado.

### Qué cambió

| Pieza | Antes (#18) | Ahora |
|---|---|---|
| Player | tira de 32 px con "Player", la pastilla de modo y "Layout" | sin tira. Los controles van en la fila del player, a la derecha del selector 1x y fuera de la caja del player |
| Pastilla "Minimized" / "Docked" | en todas las tiras | no existe más. El chevron del título ya dice si la sección está abierta |
| Botón Layout | ícono más la palabra "Layout" desde `@md` | solo ícono, con `aria-label` y tooltip. El menú no cambia: sigue teniendo Dock, que no tiene ícono propio |
| Íconos de modo | no había | al lado de Layout: minimizar o expandir, maximizar (o volver al lector si ya está maximizada) y ocultar. Uno por acción, un clic cada uno |
| Resto de las secciones | título, pastilla, "Layout" | título, y la misma fila de íconos que el player |

Los íconos llaman a las mismas acciones del store que ya existían
(`setReaderSectionMode`, `maximizeReaderSection`, `restoreReaderSection`, por
medio de `changeSectionMode` y `toggleMaximizedSection` en `SourceReader`). No
se agregó estado.

La fila de íconos es un componente propio, `ReaderSectionActions`, en
`ReaderSectionControls.tsx`. Las tiras con título la usan a la derecha del
título, y el player la recibe por la prop `controls` de `ReaderPlayer`.

Por qué cuatro íconos y no uno que cicle entre modos, como decía la nota del
primer paso: un ciclo que termina en "ocultar" hace desaparecer la sección al
cuarto clic, y para llegar a "maximizar" hay que pasar por los otros. Con un
ícono por acción cada una cuesta un clic y el tooltip dice qué hace.

### Cómo se fija el player sin tira

El player no tiene título, así que no tiene una tira que fijar. Se resolvió así:

| Modo del player | Qué se fija | Lugar en la pila |
|---|---|---|
| `expanded` | nada. El gráfico es demasiado alto para fijarse y se va al scrollear | ninguno. La sección siguiente hereda el lugar 0 |
| `compact` / `docked` | el player mismo, como barra de una línea de 32 px | el lugar 0, igual que una tira |
| sin archivo local | no hay player | ninguno |

La barra es el cuerpo de la sección del player con las mismas clases que una
tira: `h-8`, `sticky`, el mismo `top` y el mismo aspecto al fijarse. Para que
entre en 32 px, la pastilla del player pasó a medir exactamente eso (botón de
play de 28 px, 1 px de padding y 1 px de borde arriba y abajo). Con eso la pila
sigue en múltiplos de 32 px sea cual sea la sección que ocupa el lugar 0.

Para expandir un player minimizado que está fijado arriba alcanza con el ícono
de expandir; el player vuelve a su lugar en el flujo, arriba, que es donde
Sebastián dijo que se puede volver scrolleando.

De paso se corrigió un defecto del primer paso: con una grabación sin archivo
local no se renderiza el player, pero su lugar en la pila seguía reservado, y
todas las tiras se fijaban 32 px más abajo, sobre una franja vacía. Ahora el
orden de la pila excluye al player cuando no hay player o cuando está expandido.

Lo que no cambió y sigue cubierto por la prueba "leaves no box between a section
header and the scrolling column": entre cualquier elemento que se fija (tira o
barra del player) y `reader-scroll-body` no hay ninguna caja. La prueba ahora
busca el elemento fijable por `data-reader-pin` y corre dos veces, con el player
minimizado (la barra tiene que cumplir la regla) y expandido (no tiene que haber
nada fijable).

### Acciones y decisiones minimizada

Minimizada, la sección son dos elementos: el centinela, que no ocupa alto, y la
tira de 32 px. La tira muestra solo el título. Lo que sobraba era la pastilla
"Minimized" y la palabra "Layout", que ocupaban ancho, no alto; el alto ya era
de 32 px desde el primer paso.

### Pruebas

Archivo nuevo `SourceReader.compaction.test.tsx`. A diferencia de las otras
suites de `SourceReader`, no mockea `WaveformPlayer`, porque "al lado del
selector 1x" solo se puede probar contra la fila real del player.

| Criterio | Prueba |
|---|---|
| sin "Player" en la sección del player | `shows no "Player" label anywhere in the player section`, `stays untitled when minimized` |
| sin "Minimized" | `shows no "Minimized" or "Docked" label with every section minimized or docked` |
| Layout solo ícono, al lado del 1x, fuera del player | `is an icon with no text, immediately after the speed selector` (expandido y minimizado), `has a tooltip that names it`, `still opens the full layout menu` |
| íconos de modo | `sits right after Layout, each icon-only with a name`, `minimizes and expands through the store`, `maximizes, then returns to the reader…`, `hides the player…`, `names each icon in a tooltip` |
| resto de las secciones | `keeps the label in the strip and makes every control an icon`, `offers Expand once a labeled section is minimized, with no pill` |
| acciones minimizada = 32 px | `renders only the zero-height sentinel and the 32px strip` |
| el fijado sigue apilando | en `SourceReader.stickySections.test.tsx`: la prueba de "no box" extendida, `pins the minimized player bar…`, `never pins an expanded player…`, `stacks a minimized player bar in slot 0…`, `gives slot 0 to metadata when the recording has no player at all` |

Cada prueba nueva se corrió contra el código de #18 y falla ahí (20 fallas),
salvo `still opens the full layout menu` y `stays untitled when minimized` en su
primera versión. La primera es una guarda de regresión a propósito. La segunda
pasaba por un error de la prueba: `textContent` junta los textos sin espacio
("PlayerMinimized"), y la expresión con `\b` no encontraba "Player". Se cambió a
buscar la palabra sin límites.

### Lo que no se pudo verificar

Igual que en el primer paso: esta sesión no abre la app. No está visto en
pantalla que la pastilla de 32 px se vea bien, que los íconos queden alineados
con el 1x en el modo expandido (la cuenta está en el comentario de
`ReaderPlayer`: 15 px de margen inferior), ni que la barra del player se fije
arriba en la app real. Lo verifica el coordinador en vivo.
