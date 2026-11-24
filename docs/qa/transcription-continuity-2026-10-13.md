# Transcripción larga: corrección y validación

Fecha: 13 de octubre de 2026. Estado: ocho motores disponibles verificados en
inferencia real; grabación de más de una hora verificada en Cohere y Photon/Qwen.
Los motores no disponibles mantienen validación parcial; ver límites al final.

## Qué pasó

El código existente de Gemini conserva divisores de audio, offsets y continuidad entre
fragmentos. La nueva ruta de Gamestation utiliza adaptadores distintos. Dos de ellos
rechazaban el archivo completo al superar 60 minutos antes de ejecutar sus divisores:
`asr_worker.py` y `photon_asr_worker.py`.

Rec07 dura 3639,852 segundos. Su rechazo anterior era el límite del adaptador, no una
demostración de que Cohere no pudiera transcribir grabaciones largas.

También había una inconsistencia del cliente al retomar trabajos: el idioma omitido
se guardaba como ausente, pero se comparaba después contra el valor predeterminado `es`.

## Corrección aplicada

- Cohere reutiliza sus ventanas acústicas de hasta 20 segundos y la división adaptativa
  ante generación incompleta. La diarización conserva contexto acústico de la grabación.
- Photon mantiene sus ventanas de 30 segundos, con el límite de grabación común.
- VibeVoice reutiliza el normalizador y divisor común en ventanas de hasta 10 minutos;
  su entrada `context_info` recibe una cola acotada del texto anterior. Los identificadores
  de hablantes quedan limitados a su ventana; el texto anterior no confirma identidades.
- Los adaptadores omiten inferencia solamente cuando toda la ventana contiene samples
  exactamente cero. Conservan cualquier sample no nulo, incluyendo el mínimo PCM16.
  Los tiempos siguientes siguen referidos al archivo original.
- El cliente compara el idioma efectivo, conserva el mismo trabajo al reconectar y
  muestra el detalle de errores terminales. No reenvía audio por un fallo terminal.

Se reutilizaron los helpers existentes; no se reemplazó la pipeline por otra.
El límite de seguridad existente continúa en seis horas. Además hay límites de tamaño,
memoria y tiempo de ejecución: aceptar una duración no garantiza terminar dentro del
presupuesto de cualquier motor y cualquier hardware.

## Evidencia real

| Prueba | Resultado observado |
| --- | --- |
| Cohere, Rec07 completa de 60:40, dos canales, CUDA | Completó en 169,4 s; 796 segmentos; salida hasta 3637,75 s; hash y tiempos correctos. |
| Siete motores restantes disponibles, muestra conocida de inglés de unos seis segundos | Todos completaron; error de palabras cero en esa muestra. Esto no mide precisión general. |
| Cliente real retomando el trabajo completado de Cohere | Mismo ID y 796 segmentos; sólo solicitudes GET; ningún POST ni reupload. |
| Cliente real observando el trabajo terminal antiguo | Conservó el mensaje del límite de 60 minutos y la prohibición de retry automático. |
| Reinicio autorizado de HiDock | PID nuevo 25680, health HTTP 200, Rec07 guardada sin reemplazo, cola vacía. |
| Photon/Qwen 1.7B, primera prueba larga | Se canceló la prueba aislada a los 1567 s tras observar inferencia sobre silencio digital exacto. No se considera un pase. |
| Photon/Qwen 1.7B, prueba larga tras corregir silencio | Completó los mismos 60:40 en 63,8 s; 151 segmentos, hash correcto y tiempos hasta el final. |
| Ocho motores disponibles, voz conocida seguida de 45 s de silencio digital | Todos completaron y obtuvieron error de palabras cero en esa muestra. |

Las pruebas independientes no reemplazaron el transcript guardado en la app. Los
trabajos y resultados de prueba quedan separados mediante IDs `asr_validation_*`.

## Matriz de adaptadores

| Motor | Ventanas existentes/conectadas | Continuidad / identidad |
| --- | --- | --- |
| Cohere Transcribe | Acústicas, hasta 20 s | Diarización de la grabación; no prompt textual ficticio. |
| VibeVoice | Hasta 600 s | Cola textual; etiquetas de voz limitadas a ventana. No instalado actualmente. |
| Parakeet TDT / ONNX | Hasta 30 s | Reloj original; identidad no inferida. |
| Qwen 0.6B / ONNX | Hasta 10 s | Reloj original; identidad no inferida. |
| Parakeet Ultra / Photon | Hasta 30 s | Tiempos de palabras del modelo. |
| Qwen 1.7B / Photon | Hasta 30 s | Tiempos de ventana; identidad no inferida. |
| Nemotron / NeMo nativo | Hasta 60 s | Reloj original; valida tiempos de palabras. |
| MOSS | Hasta 30 s | Clusters limitados a ventana; no identidad global asumida. |
| Audio8 Infinite | Hasta 30 s | Inglés/chino explícitos; no se anuncia soporte de español. |
| Gemini generativo / rango | Divisores y continuidad existentes | Cola textual o interacción anterior, según la ruta. |
| Gemini Transcribe nativo | Fragmentos dentro del límite nativo | Anotaciones nativas; no se trata como la interfaz generativa. |
| Muse Voice / MAI Transcribe | PCM incremental, hasta 600 s | IDs limitados a request; checkpoints por fragmento. |

La interfaz de contexto depende del motor. La [documentación oficial de Cohere](https://huggingface.co/docs/transformers/model_doc/cohere_asr)
describe división y reensamblado de audio largo; la [demo oficial de VibeVoice](https://github.com/microsoft/VibeVoice/blob/main/demo/vibevoice_asr_gradio_demo.py)
expone `context_info`. No se debe enviar un mismo prompt a interfaces incompatibles.

## Regresiones y límites de la validación

Pasaron 68 pruebas Python de adaptadores/división, 27 del host de trabajos/canales,
42 del cliente y proveedores de archivos cloud, y 118 de Gemini: 255 en total.
Incluyen cobertura de frames después de una hora, límites, offsets, canales, generación
incompleta y recuperación sin duplicar uploads. Las pruebas de providers cloud de
archivos usan requests simulados y conversión FFmpeg real.

VibeVoice no está disponible en Gamestation. Muse Voice y MAI no tienen credenciales
configuradas. No se instalaron modelos ni se hicieron llamadas pagas nuevas para
simular un pase. Su inferencia real sigue pendiente. Un motor nuevo necesita una
declaración explícita de idioma, ventanas, contexto y tiempos, además de pasar una
prueba de inferencia antes de anunciarse disponible.

La mejora no prueba que toda transcripción o identidad de hablante sea correcta.
La evaluación de calidad, reparación selectiva y verificación de identidad siguen
siendo trabajo separado del correcto transporte y particionado del audio.

## Trabajo que sigue pendiente

- Indicadores compactos local/Gamestation y tablero liviano de recursos en el host.
- Evaluación contextual y reparación selectiva de hablantes, tiempos, superposición
  y texto, con decisiones acotadas, evidencia y confianza calibrada.
- Pipeline modular con dependencias y actualización de resultados derivados al corregir audio/texto/identidad.
- Asociación de reuniones y agrupación en partes sin fusionar llamadas distintas.
- Validación de rendimiento de inicio y crecimiento de memoria fuera de estas pruebas acotadas.
- Pruebas reales de VibeVoice, Muse Voice y MAI cuando estén disponibles y configurados.
