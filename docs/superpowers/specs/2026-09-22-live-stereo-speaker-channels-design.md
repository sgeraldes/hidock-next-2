# Transcripción en vivo: un canal por hablante, no un promedio

Fecha: 2026-09-22
Estado: spec aprobado, en implementación
Feature 1 de 4 de la cola del 22-sep. PR propio, revisión adversarial antes del merge.

## El defecto

`hidockRealtimeToMonoPcm` en
[gemini-live-transcription.ts](../../../apps/electron/electron/main/services/gemini-live-transcription.ts)
promedia los dos canales del dispositivo en uno:

```ts
outView.setInt16(frame * 2, Math.trunc((left + right) / 2), true)
```

El dispositivo manda **estéreo** PCM16LE (`RealtimeData`, `jensen-device.ts:187`:
"8-byte metadata header followed by stereo PCM16LE"), y la Live API de Gemini
**no hace diarización** — está documentado: "Speaker diarization: Not available
in live streaming (only in batch mode)"
([docs](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)).

Entonces el promedio tira justo la única información que permitiría saber quién
habló, y la tira antes de que salga de la máquina. Un canal es el micrófono
(vos) y el otro la contraparte; mezclados, el transcript en vivo queda sin
atribución y no hay forma de recuperarla después.

Sebastián, 22-sep: "¿Por qué convertir stereo a mono? Justamente es más fácil si
speaker y usuario van por canales diferentes."

## Lo que no sabemos y no vamos a adivinar

Dos cosas no están documentadas en el protocolo ni en el código:

1. **Qué canal es cuál.** `jensen-device.ts` dice "stereo" y nada más.
2. **Qué significa el modo.** `startRealtime(mode = 2)` manda `mode & 0x03`, un
   modo de 2 bits (0–3). El 2 es el que usa la app; los otros no se probaron.

Adivinar acá se paga con transcripts que le atribuyen tus palabras al otro. El
diseño no adivina: **mide en caliente y se corrige solo.**

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
| A | el que tiene el micrófono | `you` |
| B | el otro | `them` |

Los eventos que ya emite el servicio (`transcription-live:interim`,
`transcription-live:final`) pasan a llevar `speaker`, y `Device.tsx` lo muestra.
Sin diarización, sin heurística: la atribución la da el cable.

**Costo.** Son dos sesiones simultáneas en vez de una: el doble de minutos de
Live API mientras grabás. Se acota con la puerta de energía del punto 4.

### 3. Identificación de canal por energía, en caliente

Sobre los primeros paquetes de cada sesión se acumula el RMS de cada canal. El
canal del micrófono es, sistemáticamente, el más caliente cuando el dueño del
dispositivo habla, y el que capta el ruido de manipulación del equipo.

- Ventana: los primeros **10 s** de audio no silencioso, o 200 paquetes, lo que
  llegue primero.
- Resultado: `micChannel: 0 | 1`, persistido en la config
  (`transcription.liveMicChannel`) para que la próxima sesión arranque ya
  sabiendo, y logueado con los dos RMS para que quede evidencia.
- Mientras la ventana no cierra, las dos sesiones se etiquetan `speaker-1` /
  `speaker-2`; al cerrar, se renombran en la UI. Un transcript nunca dice "you"
  antes de que la medición lo respalde.
- Si los dos canales quedan a menos de 3 dB, la medición **no concluye**: se
  quedan `speaker-1`/`speaker-2`, que es honesto, en vez de tirar una moneda.

`transcription.liveMicChannel` se expone en Settings con tres valores: `auto`
(default, lo de arriba), `0`, `1`. Una medición equivocada se corrige a mano sin
tocar código.

### 4. Puerta de energía por canal

Un canal en silencio no se manda. Por paquete, si el RMS del canal está por
debajo del piso, ese canal no entra a su sesión. Esto:

- corta a la mitad (o menos) el costo real de las dos sesiones, porque en una
  reunión normal habla uno a la vez;
- evita que la VAD de Gemini gaste turno en silencio;
- **no** sustituye al `audioStreamEnd`: las sesiones se cierran igual al parar.

Piso: RMS por debajo de `-45 dBFS` sostenido. Configurable no; medido y fijo,
con el valor justificado en el código.

### 5. Degradación, explícita

| Caso | Comportamiento |
|---|---|
| El paquete llega mono (largo impar de frames, o firmware que manda 1 canal) | una sola sesión, etiqueta `speaker`, como hoy |
| La segunda sesión no conecta | se sigue con la primera y se emite `transcription-live:error` una vez; el transcript no se corta |
| La medición no concluye | `speaker-1` / `speaker-2` |
| Firmware sin soporte realtime | igual que hoy: `supportsRealtimeFirmware` corta antes con el mensaje que ya existe |

La rotación de sesión a los 9 minutos (el límite documentado es 10) se aplica a
**cada** sesión por separado, con su propio reloj: hoy hay un solo `openedAt`.

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
  9 min, y la caída de una no arrastra a la otra.
- Etiquetas: antes de concluir la medición nunca se emite `you`/`them`.

Verificación real (requiere el dispositivo y hablar):

- Grabar 30 s hablando solo yo, 30 s con audio del sistema, y confirmar en el log
  que el RMS del canal elegido sigue a quien habla.
- Confirmar en la UI que el turno queda del lado correcto.

## Criterio de éxito

Con el dispositivo grabando, el panel en vivo muestra dos columnas de turnos
atribuidas al canal correcto, la atribución la respalda una medición logueada, y
el costo de Live API no se duplica en silencio.
