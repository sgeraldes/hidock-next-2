# Revisión acotada de integración VAD / Voice Energy

Fecha: 2026-10-17
Alcance: revisión de fuente y artefactos retenidos del core r4 y el shim/manifest final `out-provisional-link-20261017-r5-dispatch-fix5`. No se modificaron firmware, SDK ni archivos de integración; no se ejecutaron pruebas, suites, compilaciones ni operaciones sobre hardware. El ELF de 13.600 bytes sigue siendo una propuesta offline, sin VMA reservada ni composición en SYS.

## Resultado

No encontré un defecto material nuevo en el ABI del shim F11A V2, en el forwarding de V1/F117, ni en la construcción atómica de la respuesta. El recibo retenido registra ocho casos host focalizados aprobados; no los repetí. Esto no valida ejecución C-SKY ni una imagen compuesta.

El ELF y el manifiesto r5 están enlazados entre sí: el SHA-256 observado del ELF coincide con `fabcf97d7dc010f3ff8b1d007628ed2529e7aad6fc1988d72399fc4515586cd3`; los hashes retenidos de fuente del shim, header, call sites, receta y fixture también coinciden con `build-receipt.json`.

## Evidencia del shim y del ABI

- El nuevo parse shim reconoce únicamente `frame != NULL`, `body != NULL`, `length == 1`, `body[0] == 2` y comando F11A en el head. Reutiliza `console630_vad_parse_current` en `0x01128d08` con el byte sintético V1 `1`; solo si el parser existente devuelve `0`, cambia `head[9]` a `2`. El parser existente conserva sus comprobaciones de comando pendiente, head/context, longitud declarada y fragmento. V1 y el resto del tráfico vuelven al mismo wrapper VAD-aware.
- El response shim entra en V2 únicamente cuando comando F11A y estado guardado `head[8] == 0 && head[9] == 2` coinciden. Lee exclusivamente el snapshot cacheado. Construye y valida primero los 32 bytes en una variable local y recién después copia a `output + 12`; un reply inválido o capacidad menor que 32 devuelve `-2` sin copia parcial. `-2` coincide con la rama de error que maneja el wrapper response externo; `-1` y las respuestas V1/no-F11A se delegan al camino previo.
- El contrato de capacidad observado en el wrapper response VAD-aware es el mismo que usa el shim: requiere `capacity >= 32` y escribe 32 bytes desde `output + 12`. El resolver exacto retenido es identidad (`mov r0,r1; jmp r15`), por lo que no demuestra límites de asignación. La integración depende del contrato nativo de que el buffer incluya los 12 bytes de prefijo más el área de payload anunciada. No cambiar el umbral a 44 sin evidencia de que ese campo representa tamaño total; antes de admisión, conservar el contrato del caller en una lectura exacta del frame/buffer.
- El manifiesto fija los wrappers actuales en `0x01128d08` (parse, 178 bytes) y `0x01128bf4` (response, 276 bytes), con spans que reporta iguales en 393997 y 393998. Los call sites actuales `0x01128e68` (`ffe350ff`) y `0x01128ea2` (`ffe3a9fe`) también están fijados en ambas imágenes. El ELF enlaza contra esos wrappers VAD-aware; no contra los aliases crudos `0x0112b70c` / `0x0112b81c`, que saltarían el despacho VAD.
- C V2 conserva el layout BE de 32 bytes y el decoder TS exige el mismo estado, versión, flags y ceros reservados. No observé divergencia de ABI. El recibo r5 registra cobertura de V2 exacto, passthrough V1/F117, rechazo de request no exacto y capacidad corta sin escritura parcial.

## Condiciones para composición/admisión

1. La receta todavía no está aplicada. En el mismo SYS compuesto, el compositor debe cambiar y leer de vuelta `0x01021054: 6030 -> 8030` (alloc 96→128) y `0x0102109e: 6032 -> 8032` (zero 96→128). El loader/reader de 128 bytes no puede habilitarse si esos dos inmediatos no están presentes; las macros de admisión del build son aserciones de fuente, no prueba de composición.
2. Aplicar y leer de vuelta los tres BSR propuestos —poll `0x01020b62: 08e06941 -> 08e015b3`, parse `0x01128e68: ffe350ff -> 00e04872`, response `0x01128ea2: ffe3a9fe -> 00e05772`— contra la imagen y VMA finales. `0x01137000` es coordenada de evaluación: el recibo indica que aún no hay reserva aceptada. No asumir que la propuesta quedó aplicada por el hecho de que el ELF enlace sin símbolos indefinidos.
3. Antes de admitir una imagen compuesta, hace falta una lectura exacta acotada de esos cinco cambios y de los dos wrappers/delegates fijados por SHA. La QA retenida del SYS 393992 y los casos host r5 no cubren la ejecución de los nuevos BSR ni prueban que el compositor haya aplicado constructor y dispatch juntos. No hace falta repetir los ocho casos host ni la QA histórica; este gate debe limitarse al readback y a los cambios nuevos.
4. Mantener la llamada de poll en contexto ordinario planificado. El provider verifica que IE esté habilitado; una lectura nativa puede esperar/yield y no queda limitada por el contador de tres intentos del snapshot. No invocar desde ISR ni con IRQ deshabilitada y no presentar el loop acotado del cache como garantía hard-real-time.

## Lifetime observado

No confirmé un UAF en el SYS 393998. La secuencia retenida mantiene el objeto en registro privado durante la inicialización y publica el slot solo en la rama de éxito del hook privado; el free de fallo observado ocurre antes de esa publicación. No inferir teardown concurrente ni ampliar el análisis de teardown: la precondición heredada de arranque/no reentrada queda fuera de esta revisión. El delta de constructor 96→128 es necesario para el sidecar, pero no convierte el firmware actual de 96 bytes en un defecto por sí solo.

Referencias principales: `firmware/microphone-energy-cache-20261017/out-provisional-link-20261017-r5-dispatch-fix5/{integration-manifest.json,build-receipt.json,objdump.txt,f11a-dispatch-host-test.txt}`; `hardware-vad-trace/combined-slots-vad-393992-20261016/revisions/poll-bridge-retained-20261016/link/output-nonlto-bridge/objdump.txt`; imágenes decodificadas 393997 y 393998 citadas por el manifiesto.
