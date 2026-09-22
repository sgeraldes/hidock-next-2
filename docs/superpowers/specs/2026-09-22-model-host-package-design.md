# El paquete de la gamestation: instalar las herramientas y prestarlas por la red

Fecha: 2026-09-22
Estado: construido y mergeado en `main` ([PR #9](https://github.com/sgeraldes/hidock-next-2/pull/9)),
sin instalar todavía en la gamestation.
Feature 3 de 4 de la cola del 22-sep. Corregido el 22-sep contra el código tras un QA
que leyó este documento afirmación por afirmación.

## El pedido

Sebastián, 21-sep: "el paquete para instalar todo en la gamestation, que permita
correr las tools? eso donde está? terminado?". Y de nuevo el 22: "Te pedí también
desarrollar el paquete de instalación para gamestation, construirlo, no???"

La gamestation es otra máquina: RTX 4090, Ryzen de 16 núcleos, 64 GB. La máquina
donde corre HiDock hoy tiene GPU AMD, así que cada `cuda:0` que hay en el código
cae en silencio a CPU. Diarizar una hora de audio ahí tarda lo que tarda un
procesador, y es el consumo que motivó todo el trabajo de memoria de esta semana.

## Lo que ya está escrito y no se va a reescribir

`docs/performance/native-windows-model-host-spec.md` (v1.0, 17-sep) es la
especificación completa del Model Host: instalador firmado, asistente de primera
corrida, packs de modelos con manifiesto firmado, supervisor Win32 con Job
Objects, gobernador de recursos, modo gaming, pareo de clientes, protocolo de
trabajos durables. Son semanas de trabajo y sigue siendo el destino.

Este spec no lo reemplaza. Define **la primera rebanada que se instala y
funciona**, y dice qué queda afuera para que nadie la confunda con el host
completo.

## Qué entra en esta rebanada

Una sola capacidad, de punta a punta: **diarización** (el worker de
speaker-linking que ya existe). Es la más cara en CPU, la única que hoy no tiene
aceleración en esta máquina, y la que ya tiene un contrato de entrada y salida
probado en `apps/electron/resources/speaker-linking/worker.py`.

| Pieza | Qué hace |
|---|---|
| Instalador `HiDock-Model-Host-<version>-Setup.exe` | NSIS, per-user, sin consola. Lleva el host, el worker y una copia de Node. **El Python lo baja el asistente**, no el instalador: son 2,5 GB de torch y bajarlos dentro de un instalador sin forma de pausar es peor que pedirlos una vez con la barra a la vista. Sin internet en la primera corrida, el asistente no puede terminar. |
| Asistente de primera corrida | Detecta GPU y driver de verdad, instala torch CUDA desde el índice de PyTorch, baja el modelo de pyannote con el token del usuario, y corre una prueba sintética antes de decir que anda. |
| Servicio del host | HTTP sobre la LAN, autenticado con un token de pareo. Un solo trabajo pesado a la vez. |
| Panel de control | Una página en `http://localhost:<puerto>` con Iniciar, Pausar y Detener. |
| Cliente | Un ajuste con la dirección del host. Si el host no contesta, diariza local como hoy. |

El spec grande pide una **bandeja de Windows** y esta rebanada entrega una página
local en su lugar. Una bandeja necesita un toolkit gráfico, y la única forma de
probarla es mirándola: la máquina donde trabajo tiene prohibido robar el foco, así
que una bandeja se entregaría sin verificar. La página se prueba con `curl` y da
los mismos tres controles. La bandeja vuelve cuando el host completo la traiga.

### El contrato de red

Tres rutas, nada más:

| Ruta | Qué devuelve |
|---|---|
| `GET /health` | versión, capacidades verificadas, estado (stopped/ready/paused/busy), GPU detectada |
| `POST /pair` | canjea un código de 8 dígitos que muestra el panel de control por un token permanente |
| `POST /jobs/diarize` | recibe el audio, devuelve el mismo JSON que produce hoy el worker local |

El audio viaja por el cuerpo de la petición y el host lo borra al terminar el
trabajo. El host no monta discos del cliente, no ve la base de datos y no toca el
USB.

### La degradación, que es la mitad del valor

| Caso | Qué pasa |
|---|---|
| El host no contesta | Se diariza local, como hoy. Un aviso, una vez, no por grabación. |
| El host contesta pero está pausado | Igual que arriba. El cliente no encola esperando. |
| El host falla a mitad del trabajo | Se reintenta local. La grabación no se cancela. |
| No hay host configurado | Todo igual que hoy, sin ruta nueva. |

Que el host esté caído no puede impedir arrancar la app, navegar la biblioteca,
reproducir, editar ni buscar. Eso ya es requisito P04 del spec grande y acá se
cumple porque el camino local sigue entero.

## Qué NO entra, dicho en voz alta

Queda para el host completo, en el orden en que lo haría:

- **ASR y embeddings remotos.** El mismo molde sirve, pero cada uno trae su pack
  de modelo y su presupuesto. La rebanada prueba el molde con uno.
- **Supervisor Win32 con Job Objects.** Acá el host es un proceso de Node que
  lanza Python y lo mata al parar. Un cuelgue del proceso padre puede dejar
  Python vivo; el spec grande resuelve eso con Job Objects y es real.
- **Gobernador de recursos compartido.** Hay un tope de CPU por worker (el que ya
  existe, `HIDOCK_DIARIZATION_THREADS`) y un trabajo pesado a la vez. No hay
  presupuesto de VRAM ni admisión por memoria disponible.
- **Manifiestos firmados de packs, descargas reanudables, activación atómica.**
  El asistente baja el modelo de pyannote y verifica su hash; no hay catálogo.
- **Modo gaming persistente, arranque con Windows, cola durable de trabajos.**
  Pausar y detener existen; no sobreviven a un reinicio.
- **Firma de código.** El instalador sale sin firmar y SmartScreen va a quejarse.
  Comprar el certificado es una decisión de Sebastián, no mía.

## Testing

Unit, sin la gamestation:

- El cliente elige host o local según salud, y cae a local ante error de red,
  host pausado, timeout y respuesta con forma inesperada.
- El aviso de caída sale una vez por sesión, no por grabación.
- El token de pareo se guarda cifrado en el cliente (`safeStorage`, igual que la
  URL del calendario) y no aparece en logs. Del lado del host, `tokens.json` no
  está cifrado: lo protege el permiso del archivo (0600), y el token de Hugging
  Face va en un archivo aparte con la ACL cerrada a la cuenta que instaló.
- El host rechaza una petición sin token y con un token que nunca emitió. **Los
  tokens del host no vencen**; lo que vence es el código de pareo, a los cinco
  minutos, y muere también a los cinco intentos errados.
- El host acepta un solo trabajo pesado y responde 429 al segundo.
- El audio temporal se borra al terminar el trabajo, también cuando falla.

Verificación real, con las dos máquinas:

- Instalar en la gamestation sin abrir una consola, completar el asistente, ver
  la prueba sintética en verde y la GPU detectada por nombre.
- Diarizar una grabación real desde el cliente y comparar el JSON con el que
  produce el camino local sobre el mismo archivo.
- Medir el tiempo de las dos rutas y anotarlo.
- Apagar el host a mitad de un trabajo y confirmar que la grabación termina local.

## Criterio de éxito

Sebastián instala un `.exe` en la gamestation, completa un asistente sin tocar
una terminal, y desde la máquina de siempre una grabación se diariza en la 4090.
Si apaga la gamestation, HiDock sigue funcionando igual que hoy.
