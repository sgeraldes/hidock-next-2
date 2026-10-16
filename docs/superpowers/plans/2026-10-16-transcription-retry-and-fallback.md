# Por qué falla Gemini Transcribe y cómo reintentar sin rendirse

Pedido de Sebastián, 15-oct-2026: entender por qué falla la transcripción de Gemini, tener un buen log,
reintentar según el error (algunos una o dos veces) y, si sigue fallando, pasar a un motor local o a la
gamestation según cuál esté disponible. Que no se rinda fácil y que sea configurable desde la UI. Cohere le
parece el peor de los motores disponibles.

## Lo que pasó, medido

Seis reuniones del 13 y 14 de octubre. Todas tienen dos canales y el pipeline transcribe cada canal por
separado, en trozos de 426 s.

| Grabación | Resultado de Gemini | Voz en el primer trozo, por canal (VAD guardado) |
|---|---|---|
| Rec07 Delivery previa, 13-oct | error: "covers 29% of the 426s recording" | canal 0: 87 s, última voz en el s 399. canal 1: 156 s hasta el final |
| Rec09 Seba–Yaraví, 13-oct | error: "covers 46%" | canal 0: 1 s. canal 1: 0 s. La grabación entera tiene 56 s de sonido |
| Rec12 Practice Leaders, 13-oct | error: "covers 2%" | canal 0: 0 s. canal 1: 384 s |
| Rec16 AM3 practice, 14-oct | error: "covers 11%" | canal 0: 15 s, última voz en el s 117. canal 1: 237 s |
| Rec08 Delivery, 13-oct | completa, validez `doubtful` (30% del texto sin ubicar) | canal 0: 43 s. canal 1: 232 s |
| Rec14 entrevista Diego Ojeda, 14-oct | completa, validez `doubtful` (55% sin ubicar) | canal 0: 256 s. canal 1: 23 s |
| Rec15, 14-oct (control) | completa, `valid` | canal 0: 70 s hasta el s 405. canal 1: 275 s |

### Causa 1: el chequeo de cobertura confunde un canal callado con una respuesta cortada

`nativeCoverageShortfall` (`packages/transcription/src/engines/gemini-engine.ts`) mide hasta dónde llega
el último segmento y lo compara con el largo del trozo: menos de 55% es "incompleto". Con canales
separados, cada canal es una persona. Si esa persona no habla en los primeros siete minutos, la respuesta
corta es correcta y el chequeo la marca como falla. Rec12 canal 0 tenía 0 s de voz y falló con "covers 2%".

En el árbol que corre hoy la app, una falla de cobertura con `allowAudioRetries: false` termina la
grabación en error ("Provider response retained ... automatic audio retry disabled"), y el reintento
reusa la misma respuesta guardada, así que vuelve a fallar igual. En `main` ese caso parte el trozo en
mitades y reintenta, lo que gasta llamadas pagas sobre silencio.

Rec07 es distinto: el canal 0 tenía voz hasta el s 399 y Gemini devolvió 21 palabras hasta el s 125 (41
tokens de salida para 10.650 de audio, `status: completed`). Ahí Gemini sí cortó.

### Causa 2: el armado de líneas pierde el tiempo de cada palabra

Gemini manda el tiempo de cada palabra. En Rec14 las 24 respuestas (12 trozos por 2 canales) traen
`word_info` con inicio y fin para todas las palabras. `parseNativeTranscription` junta palabras seguidas
mientras no cambie el hablante; con un hablante por canal nunca cambia, y cada trozo queda en una sola
línea de unos 420 s y cientos de palabras. Rec14 terminó con 29 líneas para 82 minutos. La validez mide
cuánto texto cae sobre audio y en qué ritmo, y con líneas de siete minutos no lo puede ubicar: `doubtful`.
El texto está bien. Lo que se pierde es el tiempo, y por eso el bridge oculta la entrevista.

### Lo que no se sabe todavía

- Qué otros errores de Gemini aparecen en la base (cuota, 5xx, timeout, salida truncada) y con qué
  frecuencia. El log de la app solo guarda warn y error, sin la grabación, el trozo ni el canal.
- Qué motor local o de la gamestation conviene como respaldo. La evaluación del 11-oct
  (`docs/performance/asr-observed-accuracy-2026-10-11.md`) tiene a Gemini primero (1,68% WER en 119
  palabras revisadas), registra texto inventado de Cohere y repeticiones de Qwen sobre audio bajo, y no
  encontró defectos en Parakeet. Nemotron dejó `valid` a Rec07 el 13-oct. No hay WER sobre reuniones.

## Qué propongo

### Fase A: arreglar las dos causas (sin costo nuevo para verificar)

1. Cobertura contra la voz del canal. `nativeCoverageShortfall` recibe los intervalos de voz del VAD de
   ese canal dentro del trozo y compara el final del texto con el final de la voz, no con el final del
   trozo. Un trozo con menos de 5 s de voz nunca es "incompleto". Rec12 y Rec16 dejan de fallar; Rec07
   sigue fallando, que es lo correcto.
2. Líneas por pausa. `parseNativeTranscription` corta una línea cuando cambia el hablante, cuando hay una
   pausa de 0,8 s o más entre palabras, o cuando la línea pasa de 30 s. Cada línea conserva el tiempo de
   sus palabras.
3. Verificación: Rec14 se vuelve a armar desde las 24 respuestas guardadas (cero llamadas nuevas) y tiene
   que salir `valid`. Las respuestas de Rec08, Rec12 y Rec16 se borraron al rehacerlas con Cohere el
   15-oct; volver a pasarlas por Gemini son unas 60 llamadas, alrededor de 1 USD.

### Fase B: reintento según el error y respaldo según disponibilidad

Cada intento queda registrado: grabación, canal, trozo, motor, tipo de error, mensaje del proveedor,
duración y costo. Se ve en el panel de la grabación y en Settings, y se consulta por el bridge.

| Tipo de error | Ejemplos | Qué hace |
|---|---|---|
| Transitorio | 429, 5xx, timeout, red | reintenta con espera creciente, 2 veces por defecto |
| Respuesta incompleta con voz real | caso Rec07 | parte ese trozo una vez (no la grabación entera); si vuelve a fallar, pasa al respaldo |
| Entrada | audio ilegible, formato | no reintenta el mismo motor; pasa al respaldo |
| Sin crédito o sin clave | cuota agotada, clave inválida | no reintenta; pasa al respaldo y avisa |

Si el motor principal se agota, prueba los motores de respaldo en el orden configurado, saltando el que no
esté disponible en ese momento (la gamestation apagada o jugando, el motor no preparado, el runner local
ausente). Recién cuando se agotan todos queda en error, con la lista de intentos y su motivo.

Settings > Transcription: orden de motores (principal y respaldos), reintentos por tipo de error, si se
permite partir un trozo y cuántas veces, y un interruptor para no usar respaldo.

### Fase C: elegir el respaldo con datos

Correr Parakeet v3, Nemotron y Qwen 1.7B en la gamestation sobre los mismos tramos de Rec08, Rec12 y Rec14,
y comparar con el texto de Gemini ya armado: palabras, validez, texto inventado sobre silencio, tiempo.
Cohere queda afuera del orden por defecto. Con eso se fija el orden por defecto y se rehace Rec14.

## Fase A en concreto (16-oct)

Las pistas por canal son WAV mono de 16 kHz (`stored-audio-channels.ts`) y el VAD de cada canal está en el
mismo eje de tiempo (`channelPreflight[canal].activityIntervals`). Pedido agregado de Sebastián: mandar solo
los tramos con voz y recomponer, para no analizar silencio.

- `planSpeechChunks(intervalos, duración)`: tramos contiguos que cubren la voz, con 0,5 s de margen, huecos
  de menos de 2 s unidos y un tope de 20 min por tramo; un tramo de voz más largo se corta en el tope. El
  silencio entre tramos no se manda. Cada tramo conserva su inicio, así que los tiempos vuelven al eje de
  la grabación sin cuentas.
- Un canal sin voz no hace ninguna llamada.
- `nativeCoverageShortfall` mide contra el final de la voz dentro del tramo y no contra el final del tramo;
  con menos de 5 s de voz nunca es "incompleto".
- `parseNativeTranscription` corta líneas en cambio de hablante, pausa de 0,8 s o más, o línea de más de 30 s.
- El camino sin VAD (audio mezclado sin preflight) queda como hoy salvo el corte de líneas.

## Fase B en concreto (16-oct)

Hallazgos que la fijan:
- La clave de Gemini está en el plan gratuito: el 15-oct hubo cuatro "429 Rate limit exceeded ... Free Tier
  (10000 input tokens per minute) ... Please retry in 39s". Un trozo de 426 s ya son 10.650 tokens de audio.
- El camino local (`local-asr`) tiene Cohere fijo en `audio-execution-route.ts` (`AUDIO_MODELS`), y Cohere
  inventa texto sobre silencio (Rec09, 15-oct).

Diseño:
- `config.transcription.engineChain`: lista ordenada de motores (`gemini`, `remote:<modelo>`, `local:<modelo>`).
  Por defecto `gemini`, después el mejor remoto medido en la fase C, después local.
- `config.transcription.retryPolicy`: reintentos por clase. Por defecto transitorio 2 (con la espera que
  pide el proveedor o 30 s, 60 s), cuota 3 (esperando lo que dice "retry in"), incompleto con voz real 1
  (parte ese tramo), entrada 0, sin clave o sin crédito 0. `allowSplit` y `fallbackEnabled` aparte.
- Clasificación de errores en un solo lugar (`transcription-errors.ts`), con tests por mensaje real visto en
  los logs del 13 al 15-oct.
- Disponibilidad antes de cada motor de respaldo: gamestation con el modelo anunciado y sin step-aside;
  runner local presente. Un motor no disponible se saltea y queda anotado.
- Cada intento queda en `transcription_attempts` (grabación, fila de cola, canal, tramo, motor, modelo, clase
  de error, mensaje, inicio, duración, costo estimado) y en el log de actividad. Se ve en el panel de la
  grabación, en Settings y por `transcription-status` del bridge.
- Settings > Transcription: orden de motores con su disponibilidad, reintentos por clase, partir tramos sí/no,
  usar respaldo sí/no.

## Fase C: datos que ya había (11-oct, FLEURS es-419, 30 clips, 853 palabras, lectura)

| Motor | WER normalizado | Inserciones |
|---|---|---|
| Parakeet v3 | 2,70% | 0 |
| Parakeet Ultra | 3,17% | 0 |
| Qwen 1.7B | 3,52% | 0 |
| Cohere | 3,63% | 4 |
| Nemotron | 6,57% | 8 |
| Qwen 0.6B | 10,2% | 16 |

FLEURS es lectura, no reunión. La fase C agrega AMI (reuniones en inglés con referencia humana) y Rec08 por
canal (texto sobre silencio y acuerdo con Gemini) para los mismos motores y Gemini.

## Dónde se construye

La app corre desde el checkout principal con 258 archivos sin commitear, y ahí viven `allowAudioRetries`
y el guardado de respuestas que esta fase toca. Propongo lo mismo que con #179: una rama desde `main` que
trae, copiados tal cual, solo los cambios del motor y de la cola que hacen falta, más los arreglos. Así el
día que se commitee el resto, estas partes ya coinciden.
