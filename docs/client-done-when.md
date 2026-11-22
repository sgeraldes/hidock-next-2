# Cierre del cliente HiDock y del procesamiento remoto

Actualizado: 13 de octubre de 2026. Responsable: esta sesión de cliente/ASR.
Checkout de trabajo: `G:\Code\hidock-next-2`; el contexto inicial de la sesión está en
`G:\Code\hidock-next`. Este documento es la lista única de temas por cerrar de esta
sesión. Los reportes de pruebas son evidencia de cada fila, no listas de trabajo
alternativas ni aceptación del conjunto.

## Done when de esta sesión

Corrección de alcance comunicada por la sesión coordinada el 12 de octubre:
Sebastián usa el runtime de desarrollo desde consola, no el ejecutable Windows
instalado. La aceptación durante el desarrollo debe ejercitar ese runtime real.
No instalar ni repetir ensayos sobre el instalado para representar su uso actual.
El instalador/release se prepara únicamente al cerrar todo el plan (CL-10).
Las mediciones históricas del instalado se conservan como evidencia diagnóstica,
sin sustituir las pendientes de desarrollo. Toda referencia a aceptación instalada
en reportes anteriores debe interpretarse con esta corrección de alcance.

El cliente de desarrollo ejecutado desde consola procesa los audios autorizados, incluidos originales mono y
estéreo, mediante el motor y nodo seleccionados; conserva canales, tiempos y datos;
permanece utilizable bajo límites adaptativos; recupera interrupciones sin duplicar
trabajos; muestra métricas veraces; y conserva las mejoras de interfaz aprobadas.
Los motores realmente disponibles tienen pruebas y comparaciones de calidad que
justifican el default. El runtime de cliente y el backend GAMESTATION coinciden con
los artefactos probados y tienen QA de los recorridos completos; el release final
se prepara después de esa aceptación.

No se cumple por compilar, por pasar tests aislados, por instalar modelos, por un
mockup ni por una prueba del servicio que no haya ejercitado el cliente de desarrollo.
Los candidatos bloqueados se mantienen identificados, sin contarlos como probados.

## Lista única del cliente

| ID | Tema propio de esta sesión | Done when específico | Estado y evidencia disponible | Siguiente cierre |
| --- | --- | --- | --- | --- |
| CL-01 | Rendimiento y adaptación al hardware | Arranque con la biblioteca correcta y carga representativa medidos en el runtime de desarrollo real; límites de CPU/RAM/GPU efectivos, UI utilizable, sin crecimiento descontrolado ni fallback local inseguro. El perfil temporal usa la base esperada y se comprueban sus conteos. | Parcial. Dev real con copia consistente de 2226 recordings/243110 vectores: partición Gemini activa 112645, 92466 elegibles. Restore sin caché 5543 ms; repetición con caché 3114 ms y New/outside/Escape/foco PASS. Pico árbol 3143,05 MiB, RAM libre mínima 18,79 GiB, heartbeat renderer máximo 122,8 ms en repetición. No inferencia, audios ni credencial cloud real; perfil derivado y guard scoped. No acredita ausencia de freezes de Windows ni carga prolongada. | Combinar índice activo con cola autorizada y ensayar límites adaptativos sin procesar grabaciones excluidas. Evidencia: .diagnostics/client-acceptance-agents/cached-index-runtime-report.md. |
| CL-02 | Pipeline, cola y recuperación del cliente | Cancelar, reiniciar, reconectar, perder el host y fallar una etapa opcional conserva checkpoints y estado consistente; no duplica ASR ni solicitudes pagas y no deja trabajos huérfanos. | Parcial. La carrera de boot recovery se reprodujo y corrigió. Cola real Qwen 0.6B con inicio del processor durante job pendiente: un pipeline, cero recovery duplicado, un POST y un upload; español conservado ante auto. Stop, cancel confirmado y cancel rechazado con reattach explícito pasaron por HTTP loopback con recovery/createHostServer/WorkerJobs reales y ejecutor sintético; checkpoints/base cliente son fixtures. Root reejecutó 34 tests recovery/recursos y Node typecheck, luego los tres casos HTTP con el nuevo rechazo. El ensayo inicial usó reattach explícito. Ahora el supervisor conectado a start/stop reescanea cada 30 s; root reejecutó 4 suites/34 tests, incluyendo reattach automático por HTTP loopback al mismo job sin POST/upload y persistencia SQLite real en una prueba separada. No prueba interrupciones completas en UI ni caída de GAMESTATION. | Cerrar pérdida y reconexión integrados, después el recorrido de UI/host desplegado sin reintentos pagos ni trabajos ajenos. |
| CL-03 | Motores ASR y backend Windows de GAMESTATION | Cada motor disponible se selecciona en HiDock y ejecuta su rol correcto; readiness es real, lenguaje y límites se respetan, el backend se instala/actualiza y puede quedar apagado sin romper el cliente. Realtime debe tener integración real, no solo un endpoint. | Parcial. Ocho motores tuvieron pruebas de servicio/host; seis proveedores se seleccionaron en Settings sin inferencia. Qwen 1.7B, Qwen 0.6B y Parakeet TDT v3 ejecutaron colas reales estéreo en GAMESTATION. Parakeet conservó ambos canales/es, un pipeline y un upload. MAI/Muse permanecen sin inferencia por credenciales; no todos los motores/modos están aceptados en el cliente. Clef/Clef-Flash son decisiones, no ASR. | Ejercitar selección y transcripción del resto de motores disponibles desde la app, readiness y host apagado; realtime requiere recorrido completo, no un endpoint. |
| CL-04 | Accuracy, rendimiento y default de transcripción | Comparación reproducible de WER/CER, diarización cuando corresponda, omisiones, alucinaciones, latencia y recursos, con referencias válidas y resultados por motor; elegir/configurar el default justificándolo con esa evidencia. | Parcial. Hay pilotos públicos y dos extractos revisados de la biblioteca, 119 palabras normalizadas; no prueban un ganador global. Gemini permanece seleccionado. Los clips sin referencia no tienen WER. | Completar cobertura comparativa usando las referencias existentes y fuentes evaluables, sin pedir más revisiones ni enviar audios/transcripciones al usuario. |
| CL-05 | Audio almacenado mono/estéreo y nuevos formatos | Un original físico controlado pasa por el cliente de desarrollo a ASR remoto, conserva ambos canales/solapamientos y persiste/reabre sin repetir trabajos. WAV/MP3 y 64/96/128/160 kbps funcionan; roles desconocidos siguen neutrales. | Parcial. WAV físico de voz mono-activa se recuperó por pipeline manual; fixture existente WAV estéreo de dos canales activos pasó por una cola real Qwen 1.7B/es, un job/upload, persistencia y reapertura exacta sin repetir ASR. Se conservaron SHA, etiquetas neutrales y solape de segmentos gruesos. Decoder WAV/MP3 mono/estéreo pasó 10/10. No acredita mapas mic/system, timestamps precisos, accuracy ni ASR de todos los formatos. | Conservar la regresión de cola estéreo al cerrar CL-02; completar recorridos ASR de formatos/motores pendientes sin nueva anotación del usuario ni tocar grabaciones excluidas. |
| CL-06 | Observabilidad del cliente y del host | Indicadores local/remoto y tablero ligero muestran conexión, ejecución, CPU/GPU/RAM/VRAM, tiempos y tokens disponibles con alcance explícito; app y sistema no se confunden y un dato ausente no se inventa. | Parcial. QA dev mostró CPU/RAM local y host desconectado gris; estados paused/stopped/unknown tienen fuente/tests. Sonnet corrigió cero CPU sin baseline comparable y NaN de contadores del host; root reejecutó caso diagnóstico sin desvíos, 34 tests cliente y 24 host más Node typecheck. Root además pasó 30 checks del HostTelemetry/createHostServer/PairingStore por HTTP loopback con CPU/RAM reales del SO: primer CPU, GPU y tokens desconocidos null; ready/paused/stopped aplicados en proceso y servidos por HTTP. GPU fue deshabilitado por inyección. No se aplicó al backend GAMESTATION ni se probó dashboard ni transición por tray. Cobertura de workers externos sigue limitada. | Aplicar al host y verificar dashboard/estados/atribución de recursos bajo carga; no confundir counters fixture ni servicio RSS con todos los workers. |
| CL-07 | Logo y ajustes de UI aprobados | Logo aprobado en light/dark, settings reubicado, sidebar con cambios menores sin cambiar su paleta, notifications/activity reubicados; popups consistentes, cercanos al disparador, cierre exterior/Esc y métricas sin desbordes. | Parcial. Cinco menús/seis pares y light/dark pasaron en dev. Última QA real: Settings overview/sidebar, ambos landmarks, New con exterior/Esc/foco y Ctrl+K pasaron. Seis proveedores, paneles y edición/restauración de idioma pasaron; Audio8/es muestra aviso único y Test deshabilitado. QA posterior confirmó cuatro cambios entre popups, diez rutas mouse/teclado y geometría en cuatro anchos; a 1000 px el buscador conserva 173 px sin superposición. No acredita lector de pantalla. | Cerrar accesibilidad restante y recorridos no ejercitados. Mantener logo/paleta aprobados y respetar ownership de dispositivo. |
| CL-08 | Asociación de reuniones, títulos y hablantes | Los casos señalados no agrupan llamadas distintas como partes de una misma reunión ni inventan asistencia o identidad; las correcciones persisten y la automatización no las revierte. | Parcial. La búsqueda normal de la llamada ad hoc señaló su ID exacto y abrió el reader: título visible sin Practice ni part 2 of 2. La corrección persistida permanece independiente. Esto acredita ese caso visual, no todas las automatizaciones o identidades. | Verificar conservación ante recálculo/reinicio y los demás casos concretos de asociación, sin retranscripción automática ni cambios globales de identidad. |
| CL-09 | Outlook COM y configuración del cliente | Con COM desactivado, ningún camino de HiDock lo inicializa ni dispara avisos; la opción legítima permanece disponible cuando el usuario la elige. Se identifica al caller si el aviso viene de otro proceso/MCP. | Parcial. Electron Next2 no tiene inicialización Outlook COM identificada; el desktop legacy ahora exige enable_calendar_integration y el opt-in HIDOCK_OUTLOOK_COM=1, incluso antes de llamadas/reintentos posteriores. Pasaron 20 tests mock; no se lanzó Outlook. Caller histórico y verificación GUI legacy siguen sin atribuir. | Verificar el límite real del desktop legacy si se ejecuta y correlacionar futuros avisos con el caller; no cambiar la seguridad global de Outlook ni declarar resuelto por tests. |
| CL-10 | Release y aceptación final de SPEC-013 | Cliente y host empaquetados/aplicados coinciden con lo probado; pasan typechecks, integridad del paquete y QA real de los recorridos anteriores, incluyendo biblioteca completa, recuperación y accesibilidad. Toda excepción queda explícita. | Abierto. Hubo instalaciones y verificaciones acotadas. Main/web typecheck del cliente pasaron en la última comprobación, pero eso no es aceptación completa ni paquete final combinado. | Construir/aplicar la versión final cuando las integraciones estén estables, ejecutar QA independiente y cerrar fila por fila con evidencia del resultado ejecutado desde consola. |

## Límite con la sesión de firmware

### Evidencia incremental del 13 de octubre

- CL-02/CL-05, recuperación real posterior: el runtime Electron de desarrollo recuperó
  el job retenido `c062e30c-b44a-406d-b679-ed307ff0e27d` desde GAMESTATION. La misma fila
  de cola quedó completada y una transcripción de 116 palabras persistida; ambos canales
  conservan etiquetas neutrales. No hubo importación ni agregado/reintento por el helper.
  Se observaron dos GET del job existente y ningún POST/PUT. Las 15 historias anteriores
  permanecieron intactas y el índice conservó 112645 vectores. Helper exit 0; runner exit 1
  porque su observador de escrituras TLS no recibió eventos, por lo que ese guard adicional
  quedó inconcluso. No se repite ASR para reparar una medición. Pico del árbol 3246,9 MiB,
  RAM libre mínima 16,25 GiB, duración 29,03 s. El probe de UI cubre solo 534 ms después
  del restore y no demuestra ausencia de freezes en Windows durante todo el arranque.
  Evidencia: `.diagnostics/client-acceptance-agents/index-job-observe-20261013-075359`.
- Política de reintentos: root reejecutó 30 pruebas del processor. `autoTranscribe=false`
  no desactiva reintentos de filas ya fallidas; `maxRetries=0` sí los desactiva. Tres
  reintentos significan hasta cuatro intentos totales. Esto explica el arranque automático
  observado en el ensayo aislado, sin atribuirle por sí solo los freezes del equipo.
- CL-06, instalador: root reejecutó 29 pruebas con Windows PowerShell del merge real de
  configuración. Se conserva `diarizationValidation`, JSON anidado y UTF-8; las huellas
  obsoletas siguen rechazadas. El cambio todavía no está empaquetado ni aplicado al host.
  El ejecutable 0.5.3 extraído contiene telemetry/dashboard anteriores a la fuente actual.
- CL-08: el guard central preserva asociaciones humanas y pasó 7 pruebas independientes
  de root. Sigue la integración de llamadores y la revisión de escritores automáticos
  directos; no se da por cerrada la conservación ante todas las automatizaciones.

- CL-02: supervisor automático conectado al ciclo start/stop del processor. Root reejecutó
  4 suites/34 tests: HTTP loopback real con ejecutor sintético y reattach automático al
  mismo job; persistencia SQLite real comprobada por separado. Intervalo normal de 30 s,
  sin POST/upload durante recuperación. Sigue pendiente la caída/reconexión del cliente
  Electron con GAMESTATION; los mocks y loopback no sustituyen esa prueba.
- CL-07: segunda QA en Electron de desarrollo pasó cuatro cambios entre popups y diez
  recorridos de apertura/cierre por mouse y teclado. Cuatro anchos solicitados
  (1000/1249/1250/1400 px), sin superposición y con reserva de controles nativos;
  buscador de 173 px al ancho menor. Logo y paleta conservados. Evidencia:
  `.diagnostics/client-acceptance-agents/header-popup-runtime-20261013-042024`.
- CL-01/CL-05: ensayo combinado cargó 112645 vectores, importó una sola copia del audio
  antiguo autorizado y conservó el índice. La preparación de canales falló antes de
  enviar audio porque el guard del ensayo bloqueó el supervisor de recursos de FFmpeg.
  Pico árbol 3384 MiB; RAM libre mínima 19,00 GiB. No acredita ASR combinado ni ausencia
  de freezes. Se retoma únicamente el registro/cola propio; no se importa otra copia.

Los límites cortos de agentes anteriores fueron configurados por la coordinación:
20 min iniciales, varias reanudaciones de 8 min, tareas de 10–12 min y reportes de 3 min.
Los códigos 124 del watchdog no se cuentan como éxito ni rechazo del modelo.
Las tres continuaciones Sonnet actuales usan el valor normal de 90 min sin override,
con UUID, ledger y propiedad separados; no se alteró el límite global del launcher.

La sesión «Instala REA para ingeniería del HiDO» es propietaria del USB, del Jensen
nativo, del firmware/binario/flash y de la captura física. También posee sus controles
de dispositivo en `Device.tsx` / `DeviceNativeRecordingPanel.tsx`, los comandos de
grabación/calidad/gain/marcadores, el listado, transferencias, resume de dispositivo y
sus ensayos de micrófonos/parlantes. Esta sesión no duplica ni modifica esos módulos.

Esta sesión recibe los originales/evidencia de sus ensayos y prueba lo que hace el
cliente después: procesamiento, ASR, persistencia, recuperación y UI de resultados.
Una prueba física compartida tiene dos evidencias, no dos propietarios del USB.
La falta de manifiesto nativo no bloquea CL-05 con canales neutrales.

Backups/restauración y el productor de manifiesto nativo están fuera del cierre
activo del audio básico. El parser/asociación del cliente ya preparado tiene 221
pruebas combinadas, pero no está registrado en runtime y no cierra ninguna fila de
la matriz por sí solo. Su eventual conexión queda en backlog hasta tener un productor
atestable; no debe seguir desplazando las prioridades de esta sesión.

## Orden de ejecución y restricciones

El primer cierre de integración es CL-05; en paralelo se prepara CL-01 sin abrir otra
instancia que compita con la propietaria del dispositivo. Después se valida CL-02,
se completa CL-03/CL-04 y se cierran CL-06 a CL-09 antes de CL-10. Un bloqueo físico
no detiene tareas independientes del cliente. Las dependencias y cambios de prioridad
se registran aquí, sin convertir un reporte de tests en un cierre del plan.

No procesar las grabaciones excluidas por el usuario, no enviar más audios o
transcripciones para anotación, no activar auto-connect/download, no cerrar apps
ajenas ni competir por USB. GAMESTATION está autorizado como máquina de trabajo.
La prueba dentro de este alcance ya está autorizada; no requiere otra aprobación
del usuario. La disponibilidad de fixture y de la ventana de app se registra abajo.

### Avance actual del 12 de octubre, 21:53 UTC

La sesión propietaria entregó una nueva captura física controlada con voz sintética
offline en inglés: WAV PCM16LE, 16 kHz, dos canales, 2.027.676 bytes, con hash de
lectura completa y configuración del dispositivo restaurada. Confirmó el cierre
limpio de su instancia y liberó la ventana de aplicación. Esto elimina la espera
de fixture para CL-05; no demuestra todavía ASR ni la app instalada. La fuente
física de cada canal sigue sin verificar: se conservan etiquetas neutrales.

Se revisa el harness antes de ejecutarlo porque forzaba español y exigía dos
trabajos aun si un canal no contiene voz. La prueba debe admitir un canal conservado
sin transcripción cuando no hay actividad, sin inventar texto para cumplir un
contador. En paralelo, CL-01 prepara la ejecución instalada sobre la copia ya
verificada de 2.220 grabaciones y 243.110 vectores; no se vuelve a copiar la base.
CL-09 mantiene una auditoría independiente de los caminos Outlook/MCP, sin activar COM.

CL-08: consulta de solo lectura en la base real confirmó que
`2026Oct07-155612-Rec53.hda` ya tiene `meeting_id = NULL` y
`correlation_method = user_preassign_standalone`. No se modificó ni retranscribió
la llamada. Esto comprueba el vínculo persistido actual, no el refresco de su vista.
La regresión general de presentación sigue en curso: compartir un evento no prueba
que dos llamadas sean partes de una captura. La reapertura en desarrollo queda
pendiente de la ventana de app coordinada.

CL-05 avanzó en el límite real de servicios: la nueva captura física controlada
preservó dos pistas; canal 0 sin actividad no se envió a ASR, canal 1 completó un
único trabajo Qwen en CUDA en GAMESTATION. El reinicio como Node nuevo reutilizó
el resultado SQLite con cero peticiones, jobs o subidas; original íntegro, roles
neutrales, cero derivados remanentes y limpieza de los textos temporales después
de verificar. Informe observado:
[captura física y replay](../.diagnostics/physical-stereo-runtime/reports/controlled-native-voice-20261012-a.json).
La referencia usada fue el guion del estímulo, no una transcripción gold de la
captura: WER/CER de ese ensayo no justifican cambiar el default. Root corrigió
un fallo de empaquetado del harness (Electron debe quedar externo al bundle Node)
antes de enviar cualquier petición; los intentos previos tuvieron tráfico cero.
La app de desarrollo y su cola completa aún no se ejercitaron con esta captura.

CL-01 tiene corrección de fuente y benchmark nativo entregados por Sonnet:
[backup-fix-report](../.diagnostics/client-acceptance-agents/backup-fix-report.md).
La medición refutó que bajar el lote bastara: el sync final del destino producía
el stall. Flush periódico del parcial en backup rutinario redujo el máximo de
482–592 ms a 39–89 ms en ese banco; integridad y conteos de 73 tablas coincidieron.
Backup de migración conserva su camino previo. Falta compilar/aplicar y medir
en el runtime de desarrollo; durante la ventana de flash del otro propietario
no se modifica out ni se abre la app. No se atribuyen freezes generales a este
resultado acotado.

Comprobación de integración sin emit: main typecheck pasó; web typecheck falló
en `DeviceNativeRecordingPanel.test.tsx:45:26` por el literal `wav` frente a un
mock inferido como `mp3`. Se comunicó al propietario de ese test de dispositivo;
esta sesión no lo modifica ni presenta los checks combinados como aprobados.

El ensayo instalado CL-01 terminó con cierre limpio, exit 0, en 90,69 segundos:
[resumen](../.diagnostics/client-acceptance-agents/installed-startup-20261012-190038/summary.json).
Se corrigió la ruta únicamente del perfil aislado y se cancelaron ocho filas de
cola únicamente en su snapshot. Pico de working sets del árbol: 1.030,72 MiB;
mínimo de RAM disponible: 19,82 GiB; pico de respuesta health: 1.094 ms. No se
solicitó USB ni inferencia y no se escribió en el perfil productivo. El backup
post-paint de base tomó 11.665 ms y registró un stall de 1.389 ms: defecto concreto
pendiente de corrección y nueva prueba. La restauración semántica tomó 1.742 ms
con stall de 15 ms y cero documentos del espacio remoto seleccionado. Es la
biblioteca completa, pero no una carga de los 243.110 vectores de otros espacios.
No prueba interacción del renderer ni resuelve los freezes generales de Windows.

## Evidencia por tema

### Agentes y ejecución en paralelo

Estado observado el 12 de octubre de 2026, después de la consulta del usuario sobre
visibilidad. Estos son ejecutores de la lista CL, no un segundo backlog.

| Ejecutor | Modelo / ubicación | Asignación actual y propiedad | Estado observado |
| --- | --- | --- | --- |
| `completed_asr_recovery` | Codex nativo, Luna max | Recuperación cliente y matriz WAV/MP3 mono/estéreo/bitrates | Terminado; 10/10 casos de decodec reales. ASR de todos los formatos y selección por UI todavía no cerrados |
| `performance_timeline` | Codex nativo, Luna max | Gráfico, paginación y COM entregados; ahora benchmark de tres particiones vectoriales | Activo; procesos propios limitados a 4 GiB/6 CPU, sin app/modelos/red/USB |
| `done_when_audit` | Codex nativo, Luna xhigh | Auditorías CL, COM, matriz ASR y restauración vectorial | Terminado; identifica límites y huecos sin contar pruebas de servicio como aceptación completa |
| `client_header_ui` | Codex nativo, Luna max | Encabezado y partes entregados; ahora helper de QA de todos los popups y llamada ad hoc | Activo; prepara helper de diagnóstico, no ejecuta la app ni cambia firmware |
| `client_com_gates` | Codex nativo, Luna xhigh | CL-08/CL-09: auditorías de agrupación y COM | Terminado; caller de Outlook aún inconcluso |
| `manifest_numeric_precision` | Codex nativo, Luna xhigh | CL-05: wrapper diagnóstico propio | Terminado; root corrigió el bundle y observó primera ejecución y replay |
| `backup-fix` | Claude2Kiro, Sonnet 5.5, medium solicitado, suscripción 2 | CL-01: packages/database; UUID c7b3287b-f40a-4531-821c-7991a2d776f1 | Terminado; dist reconstruido y backup ejercitado en npm run dev: 9.500 ms total, 126 ms de stall máximo |
| `stereo-harness` | Claude2Kiro, Sonnet 5.5, medium solicitado, suscripción 3 | CL-05: harness físico; UUID 89232448-d630-429a-ae84-fda7e22f4473 | Terminado; un job ASR real y replay sin red. No prueba todavía la cola/UI completa |

Los agentes Claude2Kiro son procesos externos al panel nativo de subagentes Codex.
Sus ledgers privados están en `.diagnostics/client-acceptance-agents`; el modelo fue
observado como Sonnet 5.5. El stream no confirma el esfuerzo aplicado por el backend.
Los PIDs y estados son una instantánea: no prueban trabajo productivo ni aceptación.
Root verifica entregables y ejecuta el límite real; no se presenta un proceso vivo
como una corrección terminada.

### Evidencia de desarrollo incorporada después de la auditoría

- CL-01: `development-startup-20261012-200532` ejecutó `npm run dev` sobre la
  copia de 2.220 grabaciones y 243.110 vectores almacenados; el namespace activo
  restauró cero documentos. El backup duró 9.500 ms con stall máximo de 126 ms;
  el mayor stall de las diez tareas fue 307 ms en `evaluation-warning-refresh`.
  Memoria máxima del árbol dev: 2.276,64 MiB. El
  [gráfico de etapas](../.diagnostics/client-acceptance-agents/performance-timeline/performance-timeline.png)
  usa duración acumulada, no timestamps absolutos. No demuestra carga de todos
  los vectores ni cierre causal de los freezes de Windows.
- CL-05: la fuente congelada de `.diagnostics/physical-stereo-runtime/snapshot.json`
  tiene SHA 59F69ED7314D1EA946D8DEEE45737DAA75E190FBF775B0204949352B2E1BCC5A;
  el bundle realmente ejecutado tiene SHA
  B38064C267E686D85C45E54F133ABA9DD4BBEC9256B74554486B1E5B4D4934DD.
  Hubo un job Qwen real para la pista activa y replay sin solicitudes de red.
  La recuperación de ese job hacia el cliente está en implementación; el
  recorrido completo de cola/UI todavía no se ha observado.
- CL-07: `development-ui-check.json` registra cinco comprobaciones reales
  aprobadas: abrir opciones, ausencia de Close options, cierre exterior,
  Escape y selección expandida. La captura del encabezado fue inspeccionada.
  La medición geométrica automática quedó incompleta (`nodes: []`); no se
  cuenta como aceptación de desbordes en todas las densidades ni de todos los popups.
- CL-09: el repo legacy `G:\Code\hidock-next` contiene un camino a
  `Outlook.Application` en `apps/desktop/src/simple_outlook_integration.py`.
  El gate `HIDOCK_OUTLOOK_COM=1` se consulta al construir la integración; el
  arranque de la GUI no consulta `calendar_provider` antes de construirla.
  Eso es un candidato de fuente, no evidencia del caller del aviso. Se está
  verificando la semántica real de settings antes de cambiar ese gate; no se
  inicializa Outlook ni se cambian permisos globales.
- Nueva aceptación cliente: [reporte integrado](../.diagnostics/client-acceptance-agents/client-runtime-acceptance-20261012.md).
  El original controlado pasó por importación, recibo y pipeline manual; se verificó
  persistencia de transcripción y ambas pistas. La segunda corrida registró el GET
  del job existente, cero creates ASR y cero uploads, además de un POST de decisiones
  `/v1/systemone`. No equivale a cero llamadas de todos los modelos.
  Los cinco checks de menú y la geometría de botones a 1.399 px pasaron después
  de esperar la animación de cierre. Más formatos, selección/reapertura por UI,
  métricas y carga representativa siguen pendientes; no se cierra CL-05 completo.
- Matriz de formatos: `stored-format-matrix/matrix.json` y `report.md` verifican
  10/10 casos con `inspectStoredAudio`/`prepareStoredAudioChannels` reales:
  WAV mono/estéreo y MP3 mono/estéreo a 64/96/128/160 kbps. Identidad del
  original conservada, roles neutrales y cleanup comprobado. No equivale a
  pruebas físicas del firmware ni ASR de cada formato.
- Corpus vectorial real: 112.645 filas `gemini-api` (3072 dimensiones),
  130.404 `local-onnx-embed` (2048) y 61 `ollama` (768). Total: 243.110.
  La app restaura una partición activa, no todas juntas. El benchmark aislado ya
  ejercitó las tres por separado con recuentos y ranking correctos: restore+idle
  5262,9/4767,9/1357,2 ms; mayores gaps 27,2/24,2/11,1 ms; RSS árbol
  1637/1328/108 MiB. No cargó modelos ni usó red/GPU/USB. No se acreditó hash
  antes/después porque el preflight fue anterior a otra ventana de UI; no se
  atribuye el cambio de hash al benchmark. Tampoco equivale a UI bajo carga.
  Evidencia: `vector-partitions-benchmark/report.md` y `results.json`.
- Última QA integrada `development-header-acceptance-20261012-220837`: helper
  completo PASS y cierre limpio del cliente dev. Cinco menús, seis pares de
  exclusión, light/dark, llamada ad hoc sin partes y reapertura del transcript
  persistido. Telemetría local real/host desconectado verificados; GPU/VRAM
  desconocidos no se muestran como cero. Sin solicitudes a modelos/uploads;
  hashes de transcript, runs y checkpoints iguales. Pico RSS del árbol dev
  2270,30 MiB y RAM libre mínima 19,61 GiB. No cierra freezes Windows ni todo CL-07.
- El [gráfico de ruta observada](../.diagnostics/client-acceptance-agents/performance-timeline/index.html)
  separa timestamps reales del pipeline, duraciones individuales de boot,
  ventanas de recursos y benchmark vector-only. El ASR del fixture se reutilizó;
  la corrida de procesamiento tuvo POST auxiliar SystemOne, la última QA no.
- Próxima frontera CL-03/CL-05: selección ASR desde Settings y cola dev con un
  fixture autorizado de dos canales activos/solapados. Los helpers se preparan
  en paralelo sin abrir app, iniciar modelos ni solicitar captura al firmware.

- CL-01/CL-02/CL-03/CL-10: [checkpoint de SPEC-013](performance/spec-013-verification-2026-10-11.md). Sus registros históricos no reemplazan el estado de esta lista.
- CL-04: [accuracy observada](performance/asr-observed-accuracy-2026-10-11.md).
- CL-05: [verificación estéreo](performance/stored-stereo-verification-2026-10-12.md) y [exportación del WAV físico](../research/rea/completion630-lab/runtime/upload2-physical-wav-track-export.json).
- Backlog de manifiesto: [verificación aislada](../.diagnostics/manifest-parallel/root-manifest-verification-2026-10-12.md).

CL-01 tiene una nueva línea base de Windows, solo lectura, en
[resource baseline](../.diagnostics/client-resource-baseline-20261012-213905.json):
65,7% de RAM física usada, 21,57 GiB disponibles, 25,76 GiB de working sets privados
sumados y 73,36 GiB de commit sobre 108,88 GiB de límite. El proceso de compresión
ocupaba 5,31 GiB; pools residentes paginado/no paginado, aproximadamente 6,61 GiB.
Estos contadores miden conceptos distintos y pueden solaparse: no se suman como
categorías independientes. CPU fue 14% en esa muestra. No se reprodujo un freeze ni
se determinó una causa; tampoco hubo ASR, USB, cambios de configuración o cierre de
procesos en esta medición.

Una fila solo pasa a cerrada cuando su done when completo tiene evidencia observada
del límite real correspondiente. Mientras conserve alguno de los pendientes
descritos, permanece parcial/abierta; no se asigna un porcentaje ficticio de avance.



### Corrección de frontera de procesamiento y Settings

El IPC `recordings.transcribe` llama a `transcribeManually` y no a la cola
persistida. Las corridas anteriores acreditan importación, recibo, pipeline manual,
persistencia y reapertura; no acreditan ejecución de cola. CL-02 y el siguiente
ensayo CL-05 requieren `recordings.addToQueue(id, true)` con owner_requested.
La ausencia de filas de cola en los snapshots previos es consistente con ese flujo.

Settings, corrida `development-asr-settings-acceptance-20261012-224452`: seis
proveedores seleccionables, paneles separados y credenciales ausentes explícitas;
sin Save/Prepare/Test ni inferencia. Resultado parcial: Audio8 no ejercitado y panel
original no restaurado. El helper de limpieza se corrigió y pasó 6/6 tests, sin nueva
aceptación runtime todavía. No se cuentan formularios como motores ejecutados.

### Cola real de ambos canales y reapertura: 12 de octubre, 23:04–23:17 local

CL-05 tiene nueva aceptación acotada: una importación del fixture existente
old-two-source.wav, una fila durable owner_requested, un job remoto Qwen 1.7B y
un upload. Ambos canales activos, SHA original, etiquetas neutrales, transcript
persistido y solape de segmentos. La verificación por IDs pasó después de cerrar
y reabrir sin reencolar ni repetir ASR. Esto no verifica otros motores/formatos,
mapas mic/system, timestamps precisos ni nueva accuracy.

CL-02 sigue abierto con un defecto observado: la recuperación de arranque adoptó
el job que el pipeline vivo ya procesaba y repitió etapas locales, aunque no creó
otro ASR remoto. El agente de pipeline corrige esa carrera y preserva recovery de
jobs huérfanos. No se atribuye este defecto a los freezes globales sin evidencia.

El primer helper de cola quedó parcial por usar un accessor no-owner; se corrigió
y la lectura verify-only pasó sin repetir trabajo. El launcher terminó sólo ese
helper propio y cerró su app limpiamente. Pico RSS árbol dev 2436,70 MiB, RAM libre
mínima 19,01 GiB; ASR 20,205 s / pipeline 21,482 s. Reapertura corta PASS del resultado;
QA navegación posterior parcial por expectativa incorrecta sobre landing Settings.

QA Sonnet 5.5 vía Claude2Kiro no entregó reporte: watchdog de 15 min y reanudación del mismo
UUID por 10 min terminaron con exit 124. No se cuenta aprobado ni sigue ejecutándose; billing
no inferible del contador de ingestion. Revisión de harness nativa separada en
queue-helper-review.md y nueva recopilación de trazas runtime en paralelo.

### Segundo motor y follow-up de recuperación

Qwen 0.6B completó una cola real del mismo audio autorizado: un job/upload,
ASR 12,143 s, pipeline 13,398 s, ambos canales y un solo pipeline local.
Aceptación parcial por idioma auto persistido pese a es solicitado. Se corrige
la resolución de placeholders preservando idioma informado/solicitado por separado;
no se reescriben registros ni se repite ASR automáticamente. El probe extra de
startup falló por nombre de API del harness y sigue sin aceptación.

El fix de ownership más stop/cancel en await pasó 15 tests; typecheck completo
Node+Web pasó después de corregir los dos tests de UI. Auditor revisa el follow-up
sin hardware. La validación real de todas las interrupciones sigue pendiente.

### Aclaración de reintentos en Settings

El texto distingue nuevas grabaciones de la cola ya existente. El límite se expresa como reintentos adicionales: 0 desactiva reintentos automáticos y 3 permite hasta 4 intentos totales. Root pasó 31 tests de UI y typecheck web. Falta observar el texto en el runtime de desarrollo cuando terminen las ediciones concurrentes. No se modificaron valores de configuración del usuario ni se ejecutó ASR.

### Aceptación incremental adicional: asociaciones y métricas

Root pasó 20 casos nuevos del reconciliador sobre SQLite real, incluida reapertura; no es QA de la app. Los 24 casos de llamadores también pasaron. Se conserva la decisión humana ante reparación automática y fusión de grabaciones duplicadas. Siguen pendientes recalcular en el runtime y la política de borrado total de calendario.

El registro de workers del host pasó 62 tests focalizados independientes, con procesos Node propios y HTTP loopback reales. No aporta todavía RAM/CPU/GPU reales de toda la familia: el lector de memoria inyectado en esas pruebas es sintético. Se implementa un lector nativo separado; no está aplicado a GAMESTATION.

La auditoría de canales y 55 tests de recorder/Gemini/live PCM no encontraron silencio de ambos canales con microphoneMuted canónico. Se asignó un fix separado para la atribución automática de micrófono por noise floor y su persistencia global. No hubo USB ni hardware. El peer corrigió la descripción de mute en su documentación.

### Incidente P0 del 13 de octubre: aplicación de desarrollo del usuario

La aplicación real volvió a bloquear Windows y continuó trabajo no deseado, según el usuario. El log registra a las 09:17:26 un bloqueo del main loop de hasta 5870 ms durante database-backup (58609 ms totales). Esto demuestra un bloqueo específico, no que explique todos los freezes. El análisis está en .diagnostics/client-acceptance-agents/startup-delete-critical-path.md. El parche aislado de backup elimina fsyncSync del callback; dos pruebas SQLite reales pasaron, pero el parche aún no está aplicado ni probado en la app.

Delete permanently fue pulsado habilitado por el usuario. La captura 1/31 corresponde al progreso del borrado, no a una transcripción masiva iniciada por ese botón. El usuario vio respuesta tardía; el borrado finalmente informó 31 elementos locales eliminados, 27 copias de dispositivo eliminadas y 2 pendientes. Root no inició ni repitió borrados. Sigue pendiente medir y corregir bloqueo síncrono y serialización con transferencias.

Root usó las APIs normales de la instancia existente para pausar y cancelar las colas, sin cerrar la app. La respuesta de transcripción informó paused=true, cero pending/processing y cancel count=0. La configuración real encontrada tenía autoConnect, autoDownload y autoTranscribe activados; root desactivó los tres y fijó maxRetries=0 por la instrucción persistente del usuario. Los valores se verificaron en disco. El último paso de lectura de la captura de control falló por interpretar config.get como dato directo en vez de Result.data; no invalida las escrituras anteriores. El historial exacto de quién activó los flags no está probado, y el marcador de migración ya estaba presente antes del incidente.

Prioridad P0 pendiente: respetar opt-out en recuperación de colas, persistir intención de descarga, evitar bloqueo por backup y purga, y observar pausa/cancelación/borrado en el límite real sin procesar nuevas grabaciones. El nuevo diseño del lector solicitado se entrega primero como mock fiel; no constituye una reparación aplicada ni autoriza cambios de diseño adicionales.

### Preview real estéreo Rec07: reparación puntual observada

El 13 de octubre root reparó la caché de waveform de Rec07, id 3c764ae6-c8ed-4efd-bfc8-9236f584199b, mediante generación streaming FFmpeg y las APIs existentes de la instancia del usuario. El archivo local termina .wav pero es MP3 estéreo físico (metadatos del peer), 58237644 bytes. El helper procesó el archivo una vez en 4.9 s, un thread/BelowNormal, retuvo como máximo 65536 bytes de PCM por bloque y guardó sólo 1000 picos por canal. No cambió bytes del audio. El peer ya había corregido duración por IPC a 3640 s redondeados.

Root observó store con dos arrays y duración3639.852; DOM con dos canvases y dos botones mute; captura rec07-actual-reader-after.png inspeccionada muestra Channel0/Channel1 y eje1:00:40. No es inferencia de identidades ni roles Mic/System. No hubo restart, reproducción, ASR, descarga o USB nuevos. La primera espera de dos animation frames expiró porque la app estaba oculta en Settings; se verificó después abriendo Library por su enlace normal, sin repetir generación. La integración automática del helper en main y el patch MIME siguen pendientes: esta reparación puntual no prueba el comportamiento para todas las grabaciones.

El candidato de MIME pasó19tests independientes (8nuevos+11existentes), pero no está aplicado. El candidato anterior de backup NO resuelve el riesgo P0 completo: una auditoría adicional confirmó sync nativo de SQLite en el último paso de backup dentro del main. No se aplicó; requiere mover el ciclo completo a worker/utility process para establecer un límite fuerte. Evidencia: startup-backup-p0/native-final-sync-audit.md.

### Anotaciones del lector y aplicación incremental

El usuario aprobó aplicar la propuesta del lector y añadió ocho correcciones: encabezado fijo; player compacto acoplado de una fila; waveform y sentimiento opcionales visibles por defecto cuando hay datos; líneas verticales punteadas numeradas de acciones/decisiones con hover/focus coordinado; speakers y acciones acoplables con estados compactos; resumen de ancho completo sin compactarlo más; player y retranscripción también para audio sin transcript; datos físicos y reunión vinculada también en ese caso. La implementación Sonnet continúa en la misma sesión cc4e7a42-21ec-4aa8-911f-d2138a15eda5, reanudada para incorporar estas correcciones. El mock y el código no equivalen a aceptación visual en la aplicación real.

Una lectura física acotada de 64 bytes de REA68F146DA.wav encontró WAV PCM16, dos canales, 16000 Hz, 2048 bytes de audio y 2092 bytes totales: duración física 32 ms. La base conserva duración 0 y fecha 09:16:29, mientras la captura muestra 09:22. No se reescribieron esos datos ni se transcribió el audio; el mock distingue esos hechos.

El indicador de descargas fue aplicado al renderer y observado en la instancia existente: cero descargas activas, cola de 14 elementos sin procesamiento y sidebar “1 failed”; no se manipularon colas. El nuevo generador de waveform ya está en source de main/preload con 22 tests y typecheck Node aprobados, pero ese runtime sigue sin reiniciar; el hook renderer y MIME se mantienen pendientes para aplicar juntos. El backup completo en utility process sigue como candidato: la revisión encontró un posible error de envelope de mensajes del host y requiere corregirlo y probar la frontera Electron antes de aplicarlo.

Actualización posterior: la instancia PID77760 dejó de existir y se observó una nueva PID25680, creada a las15:07:33. Root no envió quit/kill/relaunch; la atribución de ese cambio se está coordinando. Su preload incluye cancelGeneration y su bundle contiene el generador adaptativo. Root aplicó juntos hook renderer y utilidad MIME; 70 tests renderer y24 main pasaron independientemente. La selección normal del audio Neobanco observó un canal/1000picos y589.716s; la del archivo corto observó dos canales/1000picos y0.032s, ambos sin error. No hubo ASR ni descarga iniciados por esas verificaciones. No prueba aún el rediseño del lector: sigue en implementación.

El backup completo y su adapter corregido se aplicaron al source, con paquete database reconstruido y typecheck Node aprobado. Un smoke aislado real Electron44.4.1 verificó WAL, quick_check y un gap máximo16.54ms sobre16666páginas. La revisión del bundle encontró otro defecto: el host queda en un chunk y su __dirname apunta al directorio equivocado para el worker. Se está corrigiendo mediante startup.runtimeDir; no se considera resuelto el startup real hasta cargar y verificar ese cambio. El mock de las ocho anotaciones pasó interacciones DOM, pero su geometría renderizada nueva continúa sin verificación visual.

### Corrección de aplicación del lector y límites pendientes

Un cambio parcial del lector aplicado por HMR rompió el render con errores de inicialización de durationSeconds y DockPlayerControls no definido. Root detuvo solamente su proceso Claude propietario, conservó el parcial y restauró el SourceReader previo completo. La Library volvió a renderizar sin cerrar ni reiniciar la app. La implementación continúa en reader-ui-staging, con la misma sesión Sonnet y ambas ventanas de edición de producción cerradas. La aceptación exige probar el componente completo antes de reemplazar el archivo y luego observar scroll, toggles y hover en la instancia real; no se presenta esa recuperación como implementación del nuevo lector.

La ruta startup.runtimeDir del backup está corregida en source. Dos smokes Electron aislados con el worker emitido desde el cwd real apps/electron verificaron WAL, quick_check, 65 filas y gaps máximos 20.75 ms y 19.72 ms. El build desde el cwd raíz había producido un error de bindings ajeno a la configuración real del app; no se requiere una regla adicional de externalización. El último cambio de host no está cargado en el bundle de la instancia abierta y el startup del usuario sigue sin aceptación final.

La auditoría de reproducción local encontró otra brecha para los formatos aceptados: readRecording transfiere todo el archivo por base64 y rechaza tamaños mayores de 64 MiB. Un WAV PCM16 estéreo a 16 kHz de una hora ocupa aproximadamente 230 MB. Preview bounded no elimina ese límite de reproducción. Se asignó un candidato aislado de streaming con rangos a Sonnet 5.5 medium, sesión f94d0182-85f0-4a74-99db-be8418c2e3bd, propiedad exclusiva local-media-streaming. No se inició reproducción, ASR, descarga ni hardware para esta auditoría.

La revisión del candidato del lector detectó Summary plegado por defecto, excepciones al toggle de waveform/sentimiento para estéreo, chips que envuelven a otra fila y números de eventos previos al orden canónico. Se interrumpió solamente el leaf Claude propio para incorporar ese feedback y se reanudó la misma sesión a las 19:41 UTC; fue coordinación de QA, no un timeout. El parcial está conservado en reader-feedback-checkpoint. La revisión independiente distingue errores reales de tests ambiguos: Category tiene un selector, pero el mock también etiqueta Playback speed como category-select; la regresión de imágenes es el bloque de datos de audio, no un fallo probado de preload. Se conservan ambos controles. Las seis pruebas sintéticas de SpeakerLaneTimeline pasaron; la integración completa sigue pendiente.

Los datos de formato del candidato aún derivaban de la extensión del nombre, que no prueba el contenedor físico. Se asignó un lector bounded de encabezados WAV/MP3, sin IPC/UI todavía, a Sonnet 5.5 medium, sesión 42666ec6-d980-4dc7-aa31-d1edfaa955fb, carpeta audio-header-metadata. Debe verificar tamaño, formato, canales, frecuencia, bitrate y duración sólo cuando el encabezado lo permite; los valores desconocidos no se inventan. Esa utilidad y su integración en el lector no están aplicadas.

Actualización 20:39 UTC: el lector de encabezados terminó con 80 tests y typecheck; QA independiente verificó 16 archivos sintéticos físicos y límites de lectura/identidad/cierre. Se copió la utilidad byte-identical a main y se añadieron contrato compartido, IPC por ID de Library, preload y hook con descarte de respuestas de selección anterior y revisión de fuente. Los 14 tests de integración/hook pasan, incluido archivo sintético real WAV bajo sufijo .hda: 2092 bytes, estéreo, 16 kHz, 32 ms, 512 kbps. Main/web typechecks pasaron antes del último ajuste del hook; repetir al componer. Aún no hay consumidor en SourceReader ni aceptación visual. El bundle out/main/index.js sigue fechado 18:07 UTC: estos cambios de main no están cargados. No hay instancia Electron/Vite de HiDock visible en el inventario actual; no se inició una nueva ni procesamiento del backlog.

El candidato streaming no se aplicó: revisión independiente detectó carreras de shutdown/open, identidad del archivo, abort del response, Pause durante carga y cierre de handles antes del hard-delete en Windows. Parent conservó snapshot y detuvo solamente Claude leaf propio PID231388 para incorporar QA, reanudando UUID f94d0182-85f0-4a74-99db-be8418c2e3bd a 20:37 UTC. No fue watchdog timeout ni cierre de la app. Política deliberada: audio del propietario en Trash puede seguir inspeccionable/reproducible; hard purge debe invalidar y cerrar streams.

### Reader annotations — reviewed source applied, 2026-10-13
All eight browser annotations are represented in the reviewed reader candidate. Applied SourceReader, WaveformPlayer, SpeakerLaneTimeline and TimelineEventList from reader-ui-composed with per-file SHA guards and before snapshots. Production renderer typecheck passed; eight targeted production suites passed, 173 tests. The isolated actual-component visual QA passed at 1440 and 840 widths, including docking, full-width complete summary, three-word horizontal action chips, linked dotted markers, independent default-on graph toggles, graph-off compact mute controls, one transport, and preserved 32ms no-speech audio facts/player. Evidence: .diagnostics/client-acceptance-agents/reader-visual-qa/reader-visual-qa-report.md and .diagnostics/reader-applied-tests.log.
This is source application and component acceptance, not live application acceptance. The user app was closed before application. No app was started/restarted, no USB operation, download or transcription was initiated. Main/preload emitted output activation and live reader acceptance remain outstanding; local media streaming is a separate unfinished acceptance item. Global done-when remains open.
