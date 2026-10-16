# HiDock: objetivos aceptados y evidencia de cierre

Estado de trabajo del 13 de octubre de 2026. **El objetivo completo sigue abierto.**
Una fila no se cierra por existir código, pasar un build o terminar un agente.

| Objetivo | Evidencia disponible | Qué falta para cerrar |
| --- | --- | --- |
| Audio largo sin regresión por motor | Cohere 60:40 en 169,4 s; Photon 60:40 en 63,8 s; ocho motores disponibles probados con voz y silencio; recuperación sin POST duplicado | Inferencia de motores opcionales cuando estén disponibles; no anunciar su validación real sin ella |
| Transcribir nuevas descargas automáticamente | UI y configuración reales: `autoTranscribe=true` | Observar una descarga nueva y su admisión una sola vez, sin admitir el backlog |
| Presupuesto adaptativo de CPU | Settings real muestra 50%; configuración guarda 50%; fallback local desactivado; workers leen el presupuesto compartido | El control antiguo de embeddings se conectó al campo actual; verificar ese control en su pantalla. El límite de threads no demuestra por sí solo un techo estricto de CPU |
| Indicadores local/remoto | Ambos botones están renderizados; abren el monitor; lectura fresca muestra ambos en reposo | QA de carga, desconexión, stale, warning y recuperación; mock de estados conforme al pedido |
| Tablero liviano en Gamestation | Existe módulo desplegado y endpoint de dashboard/telemetría | Verificar HTML servido, refresco, trabajo activo y unidades actuales; fuente desplegada difiere de la fuente del repo |
| Separar problemas de voces de problemas de palabras | Se comprobó que la entrevista conserva cinco etiquetas y fue liberada por una comparación de texto | Routing y UI específicos en implementación; aplicar/verificar en la app |
| No confundir texto confirmado con identidad verificada | Regla corregida, versión 3; 43 tests de validez/store/trust pasan | Aplicar al cliente y recomputar el caso real sin volver a transcribirlo |
| Reparación acústica independiente de ASR | Existen motor acústico y reconciliación reutilizables | Conectar un stage independiente, conservar palabras/tiempos, impedir replay de checkpoints viejos y verificar audio/atribución |
| Reparación sin carreras con trabajos activos | Guardia nueva rechaza actividad y filas pending/processing antes de borrar identidades; 17 tests pasan | Verificar handler cargado y reemplazar el flujo legacy de retranscripción |
| Confirmaciones y correcciones estables | Hay overrides, splits y journal de identidad | Confirmación de participación persistida por grabación; anclas por intervalo, control de versiones y detección de conflicto |
| Evaluador contextual y elección de acciones | Hay motores de decisión y runner textual | Contrato de evidencia global/adyacente/acústica, diagnósticos competidores, selección de muestras y acciones; modo advisory antes de calibrar automatización |
| Conocimiento derivado fiable después de corregir | Edición de texto actualiza índices y wiki | Invalidación/reconstrucción común para cambios de voces, claims, resumen, tareas y respuestas; preservar edición manual |
| No agrupar llamadas distintas como partes | Hay guards de ocurrencia/overlap/split | Validación con el caso practice/ad-hoc y datos persistidos |
| Rendimiento sin freezes de todo Windows | Medición puntual actual: ~633 MiB del árbol Electron; cola vacía; no prueba resolución de freezes | Benchmark representativo de inicio, primera transcripción, indexación y sesión prolongada; medir GPU/memoria del sistema y huecos de captura |
| Mejor calidad, no sólo menos warnings | Propuesta revisada distingue detección, reparación y verificación | Ground truth independiente y comparación antes/después; no activar reparación automática general sin calibración |

## Defectos concretos confirmados por inspección de fuente/datos

- Rec58 (`06e231a0-cf29-4e45-ba38-5838f68c723a`) tiene 158 turns y cinco etiquetas.
  La validez persistida dice `valid` y conserva la razón `more_speakers_than_invited`.
  El usuario confirmó dos hablantes reales; una comparación de palabras no verifica voces.
- `reDiarizeRecording` legacy limpia identidad y encola el pipeline completo. No fuerza una
  diarización nueva y puede reutilizar transcript/acoustic checkpoints anteriores.
- Los overrides/splits se aplican por índices de turns. Cambiar segmentación puede mover
  una corrección a otra frase; conservar filas no demuestra conservar su significado.
- No hay contrato común de invalidez/versionado de todos los derivados por reparación de voces.

## Límites operativos

No se habilita reparación automática por confianza inventada. No se hacen pruebas USB,
resets de hardware, cambios de firmware ni retranscripciones pagas para aparentar aceptación.
Se conserva el trabajo de otras sesiones, especialmente reader/waveforms, backup SQLite y
publicación de archivos. Las correcciones del main process necesitan aplicación real antes
de marcarse verificadas; el reinicio previo autorizado no valida cambios posteriores.
