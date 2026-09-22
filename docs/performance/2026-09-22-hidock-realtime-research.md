# Cómo resolvió HiDock la transcripción en vivo

Fecha: 2026-09-22
Tipo: investigación, sin cambios de código
Método: lectura del bundle JavaScript público de la web oficial, llamadas de sólo
lectura a su API pública, y búsqueda de documentación, notas de release y repos de
terceros.

## Resumen, una línea por pregunta

1. **Implementación oficial.** La app corre en el navegador, promedia los dos
   canales del dispositivo a **mono**, y manda ese PCM por **WebSocket** a su
   propio backend (`wss://hinotes.hidock.com/ws/realtime`), que devuelve texto ya
   con etiqueta de hablante porque hace **diarización server-side**
   (`enable_speaker_diarization: true`). Verificado en el bundle.
2. **Firmware.** El umbral de "live" por modelo que tenemos en el repo es
   **exactamente el que usa la web hoy**, y los números decodifican a versiones
   legibles: H1 5.3.0, H1E 6.3.0, H1E-C1 6.17.0, P1 1.3.8, P1 mini 2.3.0. Falta
   un modelo: **H1 Lite, 3.1.0**. El changelog público llega hasta **5.3.0
   (2026-07-09)**, que es justo la versión que anuncia LiveTranslation.
3. **El modo del protocolo.** No hay documentación pública de los 4 valores, y la
   app oficial **también usa sólo el 2** — el mismo literal, `startRealtime(2, 1)`.
   Nada indica que el modo cambie la configuración de canales.
4. **Qué es cada canal.** No encontrado. La app oficial calcula el RMS de cada
   canal por separado y después **no usa esos valores para nada**, ni los etiqueta.

El nombre real del producto es **HiNotes** (`hinotes.hidock.com`), y la función se
llama **Live Transcription & Translation**.

## 1. La implementación oficial

### Dónde corre

En el navegador, contra su propio backend. No hay STT en el cliente y no hay STT
en el dispositivo: el dispositivo entrega PCM crudo por USB y el navegador lo
reenvía.

El código está en `https://hinotes.hidock.com/assets/js/index-DXxQ4T5b.js`, el
bundle principal que referencia [hinotes.hidock.com](https://hinotes.hidock.com/)
(9,6 MB, bajado el 2026-09-22; `VITE_STSTEM_VERSION: "3.1.7"`). El hook
`useAudioStream` y el hook `useLiveTranslation` son el circuito completo.

### El lazo de captura

```js
// startRealtime, con reintentos: hasta 60 intentos cada 500 ms
for (let M2 = 0; M2 < 60; M2++) {
  try { if ((await W2.startRealtime(2, 1))?.result === "success") { K2 = true; break } } catch {}
  await sleep(500)
}
```

Después poll serial de `getRealtime(1)` (el 1 es el timeout en segundos), con la
misma cadencia que usamos nosotros: `const J2 = K2.rest > 1 ? 50 : 100`. Cinco
respuestas nulas consecutivas y corta con `stream-error`.

### El downmix a mono

Esto es lo que más importa para nuestra cola de trabajo. La función `P2` del hook
parsea el paquete del dispositivo, mide los dos canales, y los promedia:

```js
const F2 = Math.floor((z2.length - 8) / 4);   // 4 bytes por frame = 2 canales x 16 bit
for (let B2 = 8; B2 + 3 < z2.length; B2 += 4) {
  let I3 = e3 << 8 | J2, D3 = z3 << 8 | C3;   // left, right, little-endian
  I3 & 32768 && (I3 = I3 - 65536); D3 & 32768 && (D3 = D3 - 65536);
  K2 += (I3/32768)**2; M2 += (D3/32768)**2;   // RMS por canal
  let N3 = Math.abs(I3) < 4 && Math.abs(D3) < 4 ? 0 : (I3 + D3)/2;   // <- promedio
  ...
}
return [Math.sqrt(K2/F2), Math.sqrt(M2/F2), H2]
```

Tres cosas se leen ahí:

- El header de 8 bytes y el PCM16LE estéreo que documenta
  `packages/jensen-protocol/src/jensen-device.ts:187` quedan confirmados desde el
  lado del vendor: 4 bytes por frame, dos canales de 16 bit, little-endian.
- La app oficial **hace el mismo promedio que hacemos nosotros**, con un noise
  gate extra: si los dos canales están por debajo de ±4 LSB, el frame sale 0.
- Los dos RMS que calcula se exponen como `rmsLeft` / `rmsRight` y suben hasta el
  return de `useLiveTranslation`, pero la página que consume el hook no los
  desestructura. Están calculados y sin usar.

### El envío

El envío está desacoplado del poll por una cola drenada de a un paquete cada 10 ms.
Antes de mandar, sobreescribe los primeros 8 bytes del paquete con el timestamp
epoch en ms, y usa ese mismo número como id de secuencia:

```js
const F2 = Date.now(), W2 = u64ToBytesLE(F2)
z2.set(W2, 0), b2.current?.(z2.buffer, F2.toString())
```

El header de 8 bytes del dispositivo (`rest` en 0-3, `muted` en 4-7) se pisa y
viaja como timestamp. El servidor confirma cada frame con un mensaje `audio_ack`
que trae la secuencia, y el cliente mide RTT con eso.

### El WebSocket

```js
`${wss}://${location.host}/ws/realtime?accesstoken=${accessToken}&mode=room&language=${fromLang}`
```

`mode=room` está hardcodeado en la página; es la única construcción de esa URL en
todo el bundle. El token va en la query string.

Al abrir manda la configuración de sesión:

```json
{"type":"config","sequence":"<epoch ms>","body":{
  "language":"<from>",
  "language_hints":["<from>"],
  "translation":{"type":"one_way","target_language":"<to>|null"},
  "create_note":false,
  "save_audio":false,
  "enable_speaker_diarization":true,
  "timezone_offset":-180
}}
```

El servidor responde `{code, sequence, data:{...}}` con `data.type` en
`config` | `partial` | `final` | `audio_ack`, y en el alta manda
`data.status === "created"` con `session_id`. Cada fragmento de texto viene así:

```js
{ text, speaker, start_ms, end_ms, translation_status }   // speaker por defecto "1"
```

`translation_status` vale `original` o `translation`: el mismo canal de eventos
trae el texto en el idioma de origen y el traducido, y el cliente los pega en el
mismo párrafo. `speaker` es un número en string, `parseInt`. Hay también
`{"type":"update", body:{create_note, save_audio}}` y
`{"type":"stop", sequence}` para cerrar.

### Separación de hablantes

Por diarización en el servidor, sobre audio mono. `enable_speaker_diarization`
está fijo en `true`, no es una opción de la UI. Nada en el cliente usa los canales
para atribuir: el cliente los destruye antes de enviar.

### Proveedor de STT

**No encontrado.** La página de seguridad de HiDock nombra proveedores para la
transcripción **por lotes** —
[hidock.com/blogs/user-guide/hidock-data-security](https://www.hidock.com/blogs/user-guide/hidock-data-security)
dice que el archivo va a la API de OpenAI y que desde el 25-oct-2024 también usan
Claude, sobre infraestructura Azure — y no menciona la transcripción en vivo. El
bundle no contiene ningún host de tercero de STT: los únicos hosts externos son
OAuth (Google, Apple, Microsoft), pagos (Stripe, Paddle, RevenueCat) y assets. El
`wss` va al mismo `location.host`, así que el proveedor queda del lado del
servidor y no es observable desde el cliente.

## 2. Firmware

### Los umbrales que tenemos son los vigentes

El bundle de hoy trae la tabla completa:

```js
LIVE_SUPPORTED_DEVICES = {
  "hidock-h1":      {minVersion: 328448, label: "H1"},
  "hidock-h1e":     {minVersion: 393984, label: "H1E"},
  "hidock-p1":      {minVersion: 66312,  label: "P1"},
  "hidock-p1:mini": {minVersion: 131840, label: "P1 Mini"},
  "hidock-h1:lite": {minVersion: 196864, label: "H1L"}
}
H1E_C1_MODEL_MIN_VERSION = 397319
H1E_C1_LIVE_MIN_VERSION  = 397568
```

Coincide byte por byte con `supportsRealtimeFirmware` en
`packages/jensen-protocol/src/jensen-device.ts:133`, **salvo `hidock-h1:lite`**,
que nosotros no tenemos ni como modelo en `DeviceModel`. Un H1 Lite con firmware
3.1.0 o más nuevo tiene live en la web oficial y en nuestra app no.

### Cómo se leen esos números

`QUERY_DEVICE_INFO` arma `versionNumber` como los 4 bytes en big-endian y
`versionCode` como los bytes 1-3 separados por punto. Entonces el entero se
decodifica solo:

| versionNumber | Versión | Qué es |
|---|---|---|
| 328448 | 5.3.0 | H1, mínimo para live |
| 393984 | 6.3.0 | H1E, mínimo para live |
| 397319 | 6.16.7 | H1E: desde acá el equipo es la revisión C1 |
| 397568 | 6.17.0 | H1E C1, mínimo para live |
| 66312 | 1.3.8 | P1, mínimo para live |
| 131840 | 2.3.0 | P1 mini, mínimo para live |
| 196864 | 3.1.0 | H1 Lite, mínimo para live |
| 399104 | 6.23.0 | H1E C1, mínimo para estado de grabación |
| 66560 | 1.4.0 | P1, mínimo para estado de grabación |

La decodificación se valida contra el blog oficial: para el P1 el anuncio dice
literalmente que hay que subir a la **versión 1.3.8**
([hidock.com/blogs/user-guide/live-transcription-translation-has-arrived-for-your-hidock-p1](https://www.hidock.com/blogs/user-guide/live-transcription-translation-has-arrived-for-your-hidock-p1)),
y 66312 decodifica a 1.3.8.

### Changelog

No hay changelog de firmware en el sitio web. Sí hay una API que la propia app
consume, `POST https://hinotes.hidock.com/v2/device/firmware/list`, que responde
sin autenticación. La entrada más nueva que devuelve es:

```
version 5.3.0, publishDate 1783603608604 (2026-07-09)
### What's New
1. Added support for LiveTranslation feature.
2. Added support for recording level display and control.
### Improvements
1. Optimized the file system to improve list loading speed.
```

y hacia atrás 5.2.4 (2025-04-09), 5.2.2 (2025-02-16), 5.1.19, 5.1.15, 5.1.13,
5.1.6, 5.1.1, 5.1.0, 5.0.53 y anteriores.

Dos reservas sobre este dato, para no sobreinterpretarlo:

- **El endpoint ignora el parámetro `model` cuando no hay sesión.** Probé
  `hidock-h1`, `hidock-h1e`, `hidock-p1`, `hidock-p1:mini`, `h1e`, `H1E`,
  `hidock-h1e:c1` y `hidock-h1:lite`: los ocho devuelven la misma lista. Por el
  rango de versiones (5.x) y porque 5.3.0 es exactamente el umbral del H1, la
  lista parece ser la del H1, pero no está confirmado.
- `POST /v2/device/firmware/latest` pide parámetros que no adiviné (400 Bad
  Request con `model` y con `deviceModel`).

Con eso: **para la línea 5.x no hay firmware más nuevo que el umbral de live**, y
la versión que lo habilita es la misma que lo anuncia. Para H1E 6.x, P1 1.x y
P1 mini 2.x **no encontré changelog público**; el endpoint no discrimina por
modelo sin sesión y el sitio no publica notas por versión. Las notas que sí hay
mencionan "LiveTranslation" y "recording level display and control" — nada sobre
canales ni calidad de audio.

Los anuncios de la comunidad
([community.hidock.com/announcements](https://community.hidock.com/announcements))
son de producto, no de firmware: HiNotes 3.0 (07-abr-2026), GPT-5 (08-ago-2025),
apps móviles (03-sep-2025), beta iOS con P1 v1.2.18 (01-ago-2025).

### El "nuevo H1" es hardware

Queda a la vista en el propio bundle del vendor, que distingue las dos cosas con
constantes separadas: `H1E_C1_MODEL_MIN_VERSION = 397319` marca desde qué versión
el equipo **es** una revisión C1, y `H1E_C1_LIVE_MIN_VERSION = 397568` marca desde
qué versión ese equipo **tiene** live. El commit `abeb2c0` de este repo agrega un
USB product ID, que es la misma clase de cosa: una revisión de hardware. Nada de
eso implica firmware nuevo.

## 3. El modo del protocolo

**No encontrado** para los valores 0, 1 y 3.

Lo que sí se verificó: la app oficial embute su propia librería Jensen en el
bundle, y es idéntica a nuestro port.

```js
Jensen.prototype.startRealtime = async function (fa, ss) {
  return this.isFileListing() || this.busy() ? null
    : (this.setLiveMode(!0), this.send(new Command(REALTIME_CONTROL).body([0,0,0,1,0,0,0, fa & 3]), ss))
}
Jensen.prototype.pauseRealtime = async function (fa) { ... body([0,0,0,2,0,0,0,0]) }
Jensen.prototype.stopRealtime  = async function (fa) { ... body([0,0,0,0,0,0,0,0]) }
Jensen.prototype.getRealtime   = async function (fa) { this.setLiveMode(!0); return this.send(new Command(REALTIME_TRANSFER), fa) }
```

El único call site en toda la aplicación es `startRealtime(2, 1)`. El vendor
tampoco usa 0, 1 ni 3 desde la web. Dos detalles del wrapper oficial que nuestro
port no tiene: `isFileListing() || busy()` rechaza el arranque si el USB está
ocupado, y `setLiveMode` marca el estado antes de enviar.

Búsqueda de proyectos abiertos del protocolo: no hay ninguno que documente los
modos. `ghecko/OpenHiNotes` (12 estrellas) no tiene código de realtime — su árbol
de archivos no tiene ninguna ruta con "realtime" ni "jensen". El resto de los
repos públicos de HiDock (`kms254/hidock-mcp`, `andre-wiedemann/hidock-local`,
`mavliev/hidock-android-sync`, `build-hidock/HiDockSkill`, y varios pipelines de
Whisper) son de descarga de archivos y transcripción por lotes.
`hyemin0302/jensen-realtime` apareció en la búsqueda y **no tiene nada que ver**:
es un proyecto Vercel con `api/news.js` y `api/stocks.js`, sin README.

Un indicio de por dónde estaría la documentación real: un resultado de búsqueda
expone un GitLab interno del vendor, "Skye Yu / jensen" en
`local.test.hidock.com`, que es un host interno y no sirve contenido desde afuera.

**Nada, en ninguna fuente, sugiere que el modo cambie la configuración de canales**
(mono/estéreo, mic/sistema). El campo son 2 bits enmascarados con `& 3` y eso es
todo lo que se puede afirmar.

## 4. Qué es cada canal

**No encontrado.** No hay documentación, y la app oficial no lo sabe o no le
importa: mide los dos canales, y el resultado muere sin usarse.

Hay dos piezas de evidencia indirecta sobre el manejo de canales en el
dispositivo, ambas del mismo bundle:

- **Modos de grabación con nombre.** El parser del listado de archivos deriva un
  modo del nombre del archivo: `WHSP`/`WIP` → `whisper`, `ROOM` → `room`,
  `CALL` → `call`, con `room` como default. Son los mismos nombres que el blog usa
  para describir Live ("Room Mode (face-to-face meetings) or Call Mode (remote
  discussions with earphones)"), y el mismo vocabulario que el parámetro
  `mode=room` de la URL del WebSocket. Es un modo de captura del equipo, distinto
  del modo de 2 bits del comando 33.
- **El campo `version` del archivo codifica el formato, incluidos los canales.**
  El mismo parser calcula la duración con un divisor distinto por versión:
  `version 8 → (len-44)/16/2`, `version 9 → (len-44)/16/2/2`,
  `version 2 → (len-44)/48/2`, `version 3 → (len-44)/48/2/2`. Leído como
  kHz × bytes × canales, eso da 16 kHz mono, 16 kHz estéreo, 48 kHz mono y
  48 kHz estéreo. Es inferencia mía a partir de los divisores, no algo declarado,
  pero es consistente con que el equipo produzca material estéreo.

Tampoco encontré la frecuencia de muestreo del stream en vivo. Las dos constantes
de sample rate del bundle (`TARGET_SAMPLE_RATE=16e3`, `OUTPUT_SAMPLE_RATE=48e3`)
pertenecen al transcode con ffmpeg y al reproductor de archivos, no al camino live.
Y `getRealtimeSettings` (comando 32, `REALTIME_READ_SETTING`) está **definido y
nunca llamado** en la app oficial: aparece una sola vez en todo el bundle, en su
propia definición.

Esto tiene una consecuencia directa sobre nuestro código:
`JensenDevice.getRealtimeSettings()` devuelve `sampleRate: 16000, channels: 1,
bitDepth: 16` hardcodeados. Esos valores no vienen del dispositivo ni están
recuperados del vendor: son una invención nuestra, y `channels: 1` contradice el
propio comentario de `jensen-device.ts:187`, que dice estéreo. El único campo que
sale del dispositivo ahí es `enabled` (`body[0] === 1`).

## Lo que quedó sin respuesta

| Pregunta | Estado |
|---|---|
| Proveedor de STT del camino en vivo | No encontrado. No es observable desde el cliente; el WebSocket va al mismo host. |
| Significado de los modos 0, 1 y 3 | No encontrado. Ni docs, ni ingeniería inversa publicada, ni uso en la app oficial. |
| Qué canal es el micrófono | No encontrado en ninguna fuente pública. |
| Frecuencia de muestreo del stream en vivo | No encontrado. Ni declarada ni consultada por la app oficial. |
| Changelog de firmware de H1E 6.x, P1 1.x y P1 mini 2.x | No encontrado. El endpoint público ignora el modelo sin sesión y el sitio no publica notas por versión. |
| Si el número de hablantes de la diarización tiene tope en vivo | No encontrado. El material de marketing habla de 10 hablantes para el lote, no para vivo. |

Tres cosas que se podrían resolver midiendo, y que esta investigación no hizo
porque el encargo era de sólo lectura y hay una instancia con el dispositivo
tomado por USB:

1. Los modos 0, 1 y 3: mandar cada uno y comparar el tamaño del paquete y el
   contenido de los canales. Si un modo devuelve 2 bytes por frame en vez de 4,
   es mono, y eso se ve en la primera respuesta.
2. Qué canal es cuál: grabar hablando sólo el dueño del equipo y mirar los dos RMS.
   Es exactamente lo que ya diseñamos en
   `docs/superpowers/specs/2026-09-22-live-stereo-speaker-channels-design.md`.
3. La frecuencia real: contar bytes por segundo de pared. A 16 kHz estéreo 16 bit
   son 64 000 B/s; a 48 kHz, 192 000 B/s. Un minuto de captura desempata.

## Qué haríamos distinto

El hallazgo que cambia una decisión: **la app oficial tira los canales igual que
nosotros, y recupera los hablantes por diarización en su servidor.** Nuestro plan
de separar canales y abrir una sesión Live por canal no está copiando al vendor,
está haciendo algo que el vendor no hace. Eso es una ventaja real y también una
advertencia: nadie validó ese camino antes, y el motivo por el que ellos promedian
puede ser que los dos canales no sean lo que suponemos.

Recomendaciones concretas, en orden de valor sobre esfuerzo.

**1. Medir antes de confiar en la separación por canal.** El diseño del spec ya
tiene la medición de energía por canal y el fallback a `speaker-1`/`speaker-2`
cuando no concluye. Eso está bien y hay que mantenerlo tal cual. Lo que agrega
esta investigación es una razón más fuerte para no sacar ese fallback nunca: la
única implementación de referencia que existe promedia, y su medición de RMS por
canal está escrita y desconectada, lo que se lee como un intento abandonado.

**2. Copiar tres detalles de robustez del lazo oficial.** Son baratos y los
tenemos flojos:

| Detalle | Oficial | Nuestro |
|---|---|---|
| Arranque | `startRealtime(2, 1)` reintentado hasta 60 veces cada 500 ms (30 s de gracia) | un solo intento en `jensen-handlers.ts:545` |
| Timeout de lectura | `getRealtime(1)` — 1 segundo | default 5 s en `getRealtimeData` |
| Nulos consecutivos | 5 nulos → error de stream explícito | se ignoran y se sigue poleando |
| Guarda de arranque | rechaza si `isFileListing() || busy()` | no existe |

La cadencia de poll (50 ms con cola, 100 ms sin cola) ya la tenemos igual, en
`Device.tsx:777`.

**3. Desacoplar el poll del envío con una cola.** El oficial encola los paquetes
del USB y los drena de a uno cada 10 ms hacia el WebSocket. Nosotros mandamos a
Gemini en el mismo tick en que leemos del USB
(`gemini-live-transcription.ts:359`). Con dos sesiones Live simultáneas y un
reintento de red, ese acoplamiento hace que una demora del proveedor frene el
drenaje del buffer del dispositivo, que es donde `rest` crece y se pierden
paquetes. La cola es unas veinte líneas y saca la latencia del proveedor del
camino del USB.

**4. Agregar H1 Lite y arreglar `getRealtimeSettings`.** Dos defectos concretos
que salieron de comparar con el vendor:

- `supportsRealtimeFirmware` no conoce `hidock-h1:lite` (mínimo 196864 = 3.1.0), y
  `DeviceModel` no tiene el modelo. Un H1 Lite queda sin live en nuestra app y con
  live en la web oficial. Hay que agregarlo con el mismo umbral del vendor.
- `getRealtimeSettings` devuelve `sampleRate: 16000, channels: 1, bitDepth: 16`
  inventados, y `channels: 1` es directamente falso según nuestro propio
  comentario en la línea 187. O se borran esos campos y se devuelve sólo
  `enabled`, o se llenan con la frecuencia medida de verdad. Dejarlos como están
  es una trampa para el próximo que los lea y ajuste un resampler con eso.

**5. Adoptar el noise gate de ±4 LSB en el camino mono.** El promedio oficial pone
el frame en cero cuando los dos canales están por debajo de ±4. Nuestro
`hidockRealtimeToMonoPcm` promedia siempre. En el camino de un solo canal eso
manda dither de silencio al proveedor, que gasta turno de VAD. Es una línea. Para
el camino por canal ya tenemos una puerta a -45 dBFS en el diseño, que es más
agresiva y cumple la misma función.

**6. No perseguir los modos 0, 1 y 3 como fuente de canales separados.** No hay
nada que lo sustente y el vendor no los usa. Vale probarlos una vez, en una sesión
de banco con el dispositivo libre, con el criterio de decisión fijado de antemano
(tamaño del paquete y contenido de cada canal), y cerrar el tema con evidencia.
Diseñar algo que dependa de que el modo 1 sea "mic solo" sería apostar.

**7. Considerar la forma de la API del vendor como referencia de protocolo, no de
motor.** Su esquema de mensajes es bueno y es gratis: `partial` / `final`,
`translation_status` en `original` / `translation` sobre el mismo canal de eventos,
`start_ms` + `speaker` como clave de deduplicación de párrafo, y `audio_ack` con
secuencia para medir RTT. Nuestros eventos actuales
(`transcription-live:interim` / `:final` con `speaker`) ya se mapean casi uno a
uno; lo que falta y conviene sumar es `start_ms` como clave —- pegar por
`(start_ms, speaker)` en vez de por el último párrafo evita el problema de párrafos
que se parten cuando llegan finales fuera de orden, que es justamente para lo que
el vendor lo usa.

## Fuentes

- Bundle oficial: `https://hinotes.hidock.com/assets/js/index-DXxQ4T5b.js`,
  referenciado por [hinotes.hidock.com](https://hinotes.hidock.com/). Bajado el
  2026-09-22, 9.647.945 bytes, `VITE_STSTEM_VERSION: "3.1.7"`.
- API de firmware: `POST https://hinotes.hidock.com/v2/device/firmware/list`
  (responde sin autenticación; ignora el parámetro `model`).
- [Live Transcription & Translation has arrived for your HiDock P1](https://www.hidock.com/blogs/user-guide/live-transcription-translation-has-arrived-for-your-hidock-p1)
  — modos Room y Call, firmware P1 1.3.8, beta con tope de 1 hora por sesión, sólo
  web, P1 mini TBD.
- [HiDock Introduced Live Transcription & Translation on HiNotes](https://www.newswire.com/news/hidock-introduced-live-transcription-translation-on-hinotes-22714975)
  — anuncio; 75 idiomas, transcripción sin guardar audio.
- [HiDock Data Security](https://www.hidock.com/blogs/user-guide/hidock-data-security)
  — OpenAI y Claude sobre Azure para el camino por lotes; no menciona vivo.
- [Recent Announcements from HiDock](https://community.hidock.com/announcements)
  — anuncios de producto, sin notas de firmware por versión.
- [hinotes.hidock.com/faq](https://hinotes.hidock.com/faq),
  [hinotes.hidock.com/security](https://hinotes.hidock.com/security) — sin datos
  de proveedor de STT en vivo.
- [ghecko/OpenHiNotes](https://github.com/ghecko/OpenHiNotes) — sin código de
  realtime.
- [hyemin0302/jensen-realtime](https://github.com/hyemin0302/jensen-realtime) —
  no relacionado (noticias y cotizaciones).
- Código de este repo: `packages/jensen-protocol/src/jensen-device.ts` (líneas
  133, 187, 2655-2700), `apps/electron/electron/main/ipc/jensen-handlers.ts:538`,
  `apps/electron/electron/main/services/gemini-live-transcription.ts:99`,
  `apps/electron/src/pages/Device.tsx:760`.
