# Transcripción en vivo: preservar canales y verificar la atribución

Fecha: 2026-09-22
Estado: construido y mergeado en `main` ([PR #7](https://github.com/sgeraldes/hidock-next-2/pull/7)).
Feature 1 de 4 de la cola del 22-sep. Revisado contra el código el 22-sep por un QA
que leyó este documento afirmación por afirmación; lo que decía de más está corregido abajo.

Actualización documental del 11 de octubre: este diseño es del camino PCM realtime del host. La [guía del dispositivo](../../devices/README.md) separa ese camino del MP3 almacenado en H1E 6.2.5 y de la captura PC. El servicio actual desintercala canales y usa medición/pin para etiquetarlos; eso no confirma que cada canal sea una fuente o una persona aislada. El firmware 6.2.5 analizado queda debajo del gate realtime; sus dos productores mezclan antes del encoder. La validación física de etiquetas y del DSP sigue pendiente. [Evidencia de grabación](../../../research/rea/REPORT-RECORDING-PATHS.md).

## El defecto

`hidockRealtimeToMonoPcm` en
[gemini-live-transcription.ts](../../../apps/electron/electron/main/services/gemini-live-transcription.ts)
promedia los dos canales del dispositivo en uno:

```ts
outView.setInt16(frame * 2, Math.trunc((left + right) / 2), true)
```

El host espera **estéreo** PCM16LE (`RealtimeData`, `jensen-device.ts:187`:
"8-byte metadata header followed by stereo PCM16LE"). Según la documentación
consultada para este diseño el 22 de septiembre, la Live API de Gemini
**no hacía diarización**: "Speaker diarization: Not available
in live streaming (only in batch mode)"
([docs](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)).

El promedio descarta diferencias entre canales antes de salir de la máquina.
Si se confirma que uno transporta micrófono y el otro contraparte, preservarlos
permite atribución por fuente. Esa identidad es una hipótesis a medir por modelo
y modo; dos canales por sí solos no demuestran dos hablantes independientes, ni
permiten recuperar audio que el dispositivo ya mezcló antes de enviarlo.

Sebastián, 22-sep: "¿Por qué convertir stereo a mono? Justamente es más fácil si
speaker y usuario van por canales diferentes."

## Lo que no sabemos y no vamos a adivinar

Dos cosas no están documentadas en el protocolo ni en el código:

1. **Qué canal es cuál.** `jensen-device.ts` dice "stereo" y nada más.
2. **Qué significa el modo.** `startRealtime(mode = 2)` manda `mode & 0x03`, un
   modo de 2 bits (0–3). El 2 es el que usa la app; los otros no se probaron.

Adivinar acá se paga con transcripts que le atribuyen tus palabras al otro. El
diseño mantiene canales separados y **propone una inferencia por piso de ruido**,
con etiquetas neutras si no concluye y un pin del usuario. La inferencia no prueba
el cableado ni garantiza una corrección automática del mapa físico.

## El diseño

### 1. Separar canales en vez de promediar

`hidockRealtimeToMonoPcm` se reemplaza por `splitRealtimeChannels(packet)`, que
devuelve los dos canales ya desintercalados como dos buffers mono PCM16LE de
16 kHz, el formato que la Live API pide. Nada más cambia de formato: el
`mimeType` sigue siendo `audio/pcm;rate=16000`.

La función vieja queda exportada y con tests, porque el camino de un solo canal
la sigue usando (ver "Degradación" abajo).

### 2. Una sesión Live por canal, con etiqueta de hablante

Dos sesiones Live independientes, cada una recibiendo un solo canal:

| Sesión | Canal | Etiqueta emitida |
|---|---|---|
| A | el seleccionado como micrófono por la heurística o el pin | `you` |
| B | el otro | `them` |

Los eventos que ya emite el servicio (`transcription-live:interim`,
`transcription-live:final`) pasan a llevar `speaker`, y `Device.tsx` lo muestra.
Sin diarización en este camino: las etiquetas dependen del canal elegido por la
heurística o el pin del usuario. Sólo una validación de fuentes por modelo/modo
permite tratarlo como atribución física; un canal puede contener varias voces.

**Uso y costo.** Son dos sesiones simultáneas mientras grabás. La puerta de
energía del punto 4 reduce el audio enviado; el costo y la forma de contabilizar
sesiones/minutos requieren medición del proveedor. No se verificó una reducción
ni un multiplicador de facturación.

### 3. Identificación de canal por piso de ruido, en caliente

**Corregido en la revisión del 22-sep.** La primera versión comparaba energía
acumulada: el canal más caliente era el micrófono. Eso falla en el caso más
común que hay — en una llamada la contraparte llega a nivel de línea y suele
sonar más fuerte que el dueño del equipo, así que "gana el más fuerte" le pone
`you` al otro. Medido: 210 paquetes de dueño a 3000 contra contraparte a 9000, la
regla de energía elegía el canal 1.

La heurística compara el **piso**, no el pico. Su hipótesis es que el micrófono
recoge ruido de sala entre turnos y la contraparte digital cae más cerca de cero.
Si el DSP aplica noise gates, mezcla fuentes o cambia el procesamiento por modo,
esa hipótesis puede fallar. El candidato a micrófono es el canal con piso más alto,
medido como percentil 20 del RMS por paquete; la medición no sustituye la prueba
física con fuentes conocidas.

- Ventana: los primeros **10 s** de audio no silencioso, o 200 paquetes, lo que
  llegue primero.
- Resultado: `micChannel: 0 | 1`, persistido en
  `transcription.liveMicChannelMeasured` — **no** en `liveMicChannel`, que es el
  pin del usuario. Escribir la medición en el mismo campo convertía el "Medir
  automáticamente" elegido por el usuario en un pin a sus espaldas, y el control
  de Settings no podía deshacerlo.
- Mientras la ventana no cierra, las dos sesiones se etiquetan `speaker-1` /
  `speaker-2`; al cerrar se renombran en la UI, incluidos los turnos ya en
  pantalla (la UI guarda el canal, no la etiqueta). Un transcript nunca dice
  "you" antes de que la medición lo respalde.
- Si los dos pisos quedan a menos de 3 dB, la medición **no concluye**: se quedan
  `speaker-1`/`speaker-2`, que es honesto, en vez de tirar una moneda.

Límite conocido: si la contraparte no hace ninguna pausa en la ventana, los dos
canales miden piso alto y la medición puede errar. Para eso está el override.

`transcription.liveMicChannel` se expone en Settings con tres valores: `auto`
(default, lo de arriba), `0`, `1`. El pin del usuario siempre gana sobre lo
medido, y elegir `auto` borra los dos valores (se guarda `null`, no `undefined`,
porque el deep-merge de `saveConfig` descarta `undefined`).

### 4. Puerta de energía por canal

Un canal en silencio no se manda. Por paquete, si el RMS del canal está por
debajo del piso, ese canal no entra a su sesión. Esto:

- reduce el audio enviado en los intervalos que quedan bajo el umbral; el ahorro
  facturado depende del proveedor y de sus reglas de sesión, no se midió aquí;
- evita que la VAD de Gemini gaste turno en silencio;
- **no** sustituye al `audioStreamEnd`: las sesiones se cierran igual al parar.

Piso: **-55 dBFS** (RMS 58 de 32768), con **1 s de hangover** por canal.
Configurable no; medido y fijo, con el valor justificado en el código.

**Corregido en la revisión del 22-sep.** El piso original era -45 dBFS (RMS 184)
sin hangover, y eso perdía audio real: un paquete de voz a -50 dBFS mide RMS 73 y
quedaba afuera entero, y sin hangover se cortan los huecos entre palabras y la
cola de la última consonante. El RMS además se calcula **sin componente de
continua**: un conversor con offset fijo en 400 medía 400 de "volumen" y pagaba
una sesión Live por una línea recta.

El ahorro que esto da es menor que lo que decía el diseño: con bleed de la
contraparte a -40 dB el canal callado mide RMS 60 y pasa igual. La puerta corta
el silencio de verdad, no el crosstalk.

### 5. Degradación, explícita

| Caso | Comportamiento |
|---|---|
| El dispositivo manda un solo canal | una sola sesión, etiqueta `speaker`, tras **cinco paquetes seguidos** de un canal |
| La segunda sesión no conecta | se sigue con la primera y se emite `transcription-live:error` una vez; el transcript no se corta |
| La medición no concluye | `speaker-1` / `speaker-2` |
| Firmware sin soporte realtime | igual que hoy: `supportsRealtimeFirmware` corta antes con el mensaje que ya existe |

**Cómo se decide que el dispositivo es mono.** Un paquete estéreo siempre trae un
número entero de tramas de 4 bytes. Un payload múltiplo de 2 y no de 4 es un
flujo de muestras sueltas, o sea un canal. Un paquete así **no alcanza**: una
lectura USB truncada se ve idéntica, y degradar con el primero tiraría la
atribución de toda la sesión por un solo tropiezo. Hacen falta cinco seguidos,
que son medio segundo, y el aviso sale una vez y no por paquete. Un paquete raro
aislado se sigue transcribiendo leyendo sus tramas enteras.

La rotación de sesión a los 9 minutos (el límite documentado es 10) se aplica a
**cada** sesión por separado, con su propio reloj: hoy hay un solo `openedAt`.
Los paquetes que llegan mientras una sesión rota esperan a que abra la nueva, no
se tiran. Verificado con tres envíos concurrentes cruzando una rotación: abre una
sesión nueva por canal, no una por paquete, y los cuatro paquetes llegan enteros.

Dos `start()` superpuestos —el botón de reanudar tocado dos veces— dejaban un par
de sesiones Live abiertas sin nada que las apuntara. Cada `start()` ahora lleva
un número de generación y el que pierde la carrera cierra las suyas.

## Lo que no entra

- **Modo del dispositivo.** No se toca `startRealtime(2)`. Averiguar qué son los
  modos 0, 1 y 3 es trabajo aparte (ítem 5 de la cola, junto con lo que haga la
  página oficial de HiDock y el último firmware).
- **Diarización en vivo.** No existe en la Live API. Dos canales es la respuesta
  a eso, no un reemplazo de la diarización batch, que sigue igual.
- **Timestamps de palabra en vivo.** Tampoco existen en Live; el transcript en
  vivo es a nivel de turno, y el definitivo lo sigue produciendo el camino batch.

## Testing

Unit, sin dispositivo:

- `splitRealtimeChannels`: desintercalado correcto sobre un paquete construido a
  mano con L y R distinguibles; header de 8 bytes respetado; paquete muteado o
  corto devuelve vacío; largo no múltiplo de 4 no lee fuera del buffer.
- Identificación de canal: con L más caliente elige 0, con R más caliente elige
  1, con los dos parejos no concluye, y respeta el override de la config.
- Puerta de energía: un canal bajo el piso no se manda, el otro sí.
- Dos sesiones: cada canal va a su sesión, cada una rota por su cuenta a los
  9 min, y la caída de una no arrastra a la otra, ni al conectar ni a mitad de
  sesión.
- Mono: un paquete raro aislado no degrada nada; cinco seguidos sí, una sola vez,
  y el payload va como está en vez de promediarse consigo mismo.
- Etiquetas: antes de concluir la medición nunca se emite `you`/`them`.

Verificación real (requiere el dispositivo y hablar):

- Grabar 30 s hablando solo yo, 30 s con audio del sistema, y confirmar en el log
  que el RMS del canal elegido sigue a quien habla.
- Confirmar en la UI que el turno queda del lado correcto.

## Criterio de éxito

Con el dispositivo grabando, el panel en vivo muestra los turnos en una sola
lista cronológica, cada uno con la etiqueta de su canal (una conversación se lee
mejor intercalada que en dos columnas paralelas; lo que importa es que la
etiqueta sea la correcta, no la geometría). La atribución debe respaldarse con una
medición logueada y señales de fuente conocidas, y el uso de dos sesiones y su costo
deben ser visibles. La heurística sola no sustituye la prueba de canales del dispositivo.
