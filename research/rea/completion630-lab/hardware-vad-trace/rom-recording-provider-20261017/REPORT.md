# CMD29: productor del anillo de niveles y contrato del switch

Fecha: 17 de octubre de 2026. Investigación estática de artefactos retenidos; sin hardware, consulta DSP, build ni edición de firmware.

## Identidad y límites de evidencia

La imagen SYS exacta analizada es `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin`, SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce` (1,187,904 bytes). Direcciones SYS de abajo se refieren a esa imagen.

Corrección importante: `0x00000b4c` no es `record_mgr_getoption`; es el dispatcher C-SKY `___gnu_csky_case_uhi` (switch con offsets halfword sin signo). `0x00000b38` es el análogo byte `___gnu_csky_case_uqi`. El respaldo de nombres/tamaños está en el ELF `rom.sym` simbólico de 821 bytes; el detalle ABI proviene del objeto helper de un toolchain C-SKY relacionado, cuyo texto coincide en tamaño con los símbolos. Ese objeto preserva `r0/r1`, toma `r0` como índice, usa LR como base de la tabla inline, lee `u16le(LR + 2*r0)`, duplica ese desplazamiento y salta a `LR + desplazamiento`. **No hay bytes físicos H1E retenidos de esos stubs**: identidad/ABI son una correspondencia de símbolo y herramienta relacionada, no una verificación del contenido ROM del dock. La rama caller/table/data se observa en el SYS fijado.

## Tabla local de `FUN_0102d828`

En `0x0102d85e–0x0102d864`, el caller resta 9 al selector, valida que quede bajo 14 y llama a `0x00000b4c`. La tabla local empieza en LR/base `0x0102d868`; sus 14 halfwords little-endian son `000e 0030 007b 00a2 00e2 0033 0042 0051 00e8 0060 00e8 00e8 0065 0067`. Aplicando explícitamente el ABI anterior, los selectores relevantes llegan a:

| Opción CMD29 | Índice (`opción - 9`) | Entrada | Destino SYS | Acción visible |
| --- | ---: | ---: | ---: | --- |
| 10 | 1 | `0x0030` | `0x0102d8c8` | Copia byte `[r1+1]` a `[r4]`; en este adaptador `r4` guarda el puntero entrante. |
| 11 | 2 | `0x007b` | `0x0102d95e` | Lee el contador del reloj, resta el inicio de grabación (`manager+0x10`), divide por 1000 con `0x0000050c` y escribe un halfword. |
| 12 | 3 | `0x00a2` | `0x0102d9ac` | Comprueba tipo `4`, usa la cantidad solicitada y consume/copía bytes del anillo. |
| 13 | 4 | `0x00e2` | `0x0102da2c` | Comprueba tipo `4` y lee el contador de niveles en `+0xbe`. |
| 18 | 9 | `0x0060` | `0x0102d928` | Llama la copia de cadena de destino `0x0108ded2` desde el campo `+0x30`. |

La relación de CMD29 con estas opciones también aparece en `0103a03c–0103a0f4` dentro del constructor USB-IAP2 retenido. La forma de respuesta documentada por el análisis previo es tipo, nombre, segundos transcurridos y `M` bytes de nivel. Opción 12 reduce el contador de niveles y adelanta el índice de lectura mientras copia; no es una lectura pasiva del ring.

## Cadena de producción observada

El primer productor de bytes del anillo está en `FUN_0102bdfc` (`0102bdfc–0102be47`): toma una muestra byte en `r0`, lee el manager desde el global `0x000853ec`, y escribe en `manager + 0x94 + manager[0xbc]`. Luego avanza el índice de escritura (`+0xbc`) con el helper de resto `0x000005cc` y módulo `0x28` (40). Si el contador `+0xbe` es menor que 40 lo incrementa; cuando está lleno avanza el índice de lectura `+0xbd` con el mismo módulo, reemplazando el más antiguo. La etiqueta ABI de `0x5cc` como resto también es correspondencia de SDK/toolchain relacionada, no bytes físicos ROM H1E.

La única llamada directa al escritor es desde `FUN_0102be4c` (`0102be4c–0102bec9`). Este acumula valores absolutos de muestras `int16` en `manager+0xc0` y cantidad de muestras en `manager+0xc4`. Al superar 799 muestras, calcula `sum / 800`, escala a byte `0..255` con `*255 / 32767` y saturación superior, limpia ambos acumuladores y llama al escritor. Esto fija una cadencia por cantidad de muestras; sin tasa/ritmo del callback no la convierto a tiempo ni a dB.

Hay dos llamadores directos del agregador en este SYS:

- `audio630_candidate_0102c11c` (callback instalado por `audio630_candidate_0102c02c`, `record_mgr_channel_in_init`) procesa pares `int16` de su buffer: los suma, limita a `[-32768,32767]` y aporta una muestra agregada al mismo `FUN_0102be4c`. Requiere buffer, stream handle `param+0x18`, longitud no cero y byte de estado `param+1` distinto de cero. La configuración abre el canal AIN y registra este callback; la evidencia no identifica físicamente ese canal como Mic o System.
- `audio630_candidate_01050b0c` (`_audio_record_dsp_stream_handle`) escribe el bloque de salida por `FUN_0102da70` (`01050c92`). Ese wrapper exige stream global `manager+0x18` y flag `manager+1` activos, escribe el bloque y aporta `length/2` muestras `int16` al mismo agregador. Para el bloque estático `0x60`, eso equivale a 48 halfwords por llamada.

Ambas rutas convergen en los mismos campos `+0xc0/+0xc4` y anillo `+0x94`; el byte del ring no conserva etiqueta de ruta ni canal. En la ruta AIN se suman los dos canales antes de agregar magnitud. Por tanto esta implementación presenta un nivel mono/agregado, potencialmente alimentado por la entrada AIN y/o el callback DSP de grabación según qué rutas estén activas; no permite recuperar niveles separados mic/sistema. Los guardas muestran actualización a través de callbacks/streams activos. No prueban actualización fuera de grabación, ni demuestran semántica de detección de voz.

## Consecuencia implementable

La dependencia de recuperar un servicio `record_mgr_getoption` en ROM `0xb4c` es falsa; el switch y sus ramas están en SYS. El productor concreto ya está localizado: agregador `0x0102be4c` → ring writer `0x0102bdfc` → campos consumidos por opción 12 y consultados por opción 13. El dato es un byte de amplitud agregada, no VAD de habla. Para distinguir micrófono y sistema hace falta una ruta con etiquetas de canal separadas antes de la suma; para una señal VAD hace falta contrato/algoritmo adicional, no renombrar estos bytes.

## Fuentes exactas retenidas

- `research/rea/evidence/h1e-6.3.0-functions/0102d828.tsv` y `controls/0102bf00-0102db20.tsv`: tabla y cuerpos de opciones.
- `0102be4c.c/.tsv`, `0102bdfc.c/.tsv`: acumulador y anillo.
- `0102c02c.c`, `0102c11c.c`, `01050b0c.c`, `0102da70.c/.tsv`: rutas de entrada y DSP que llaman al agregador.
- `research/rea/protocol-depth630-lab/rom/REPORT-ROM-CONTRACT-GAPS.md`, `rom-contract-evidence.json`, `_csky_case_uhi.o.disassembly.txt`: alcance de símbolos/ABI y límites sobre la ROM.
- `research/rea/evidence/firmware-contracts.json`: correspondencia candidata de `0x5cc` a `__rem32`/`__modsi3`, explícitamente sin bytes ROM HiDock.

## Complemento: stride, selección y condiciones de activación

Este complemento sigue usando solo el SYS 6.3.0 identificado arriba y sus salidas de análisis retenidas.

- En `0102c11c`, el puntero de entrada es `param_2` y el límite del bucle es `param_3` bytes. El índice de entrada avanza cuatro bytes por iteración (`uVar1 = uVar6 * 2`, `uVar6 += 2`): carga dos `int16` contiguos, los suma, limita el resultado a `[-32768,32767]`, escribe el halfword mezclado en el buffer y llama `0102be4c(&localSample, 1)`. Por cada frame estéreo de 4 bytes aporta **un** sample mono, stride 4 antes de la mezcla y stride 2 después. No hay selección de canal en esta ruta.
- `0102c11c` solo procesa cuando `param_2 != 0`, `*(int *)(param_1+0x18) != 0`, `param_3 != 0` y `*(char *)(param_1+1) != 0`. La apertura/registro de la entrada AIN está en `0102c02c`: prepara config con callback `0102c11c`, llama `0104cc18`, configura con `0104cfa4` y habilita con `0104cea0(handle,1)`. En el SYS recuperado, `0102c02c` es llamado desde las rutas de inicio de `0102d060` en `0102d6b4` y `0102d7e2`; el primer caller verifica manager presente, flag `manager+1`, stream `manager+0x18` y `manager+3 == 0` antes de abrir y marcar `manager+3`. El segundo llama al abrir después de la preparación/reset de contadores y marca ese estado. Esto vincula el callback a una transición de stream/recording; no es una consulta pasiva incondicional.
- La ruta `01050b0c` alimenta `0102da70(buffer, 0x60)`. La ubicación del buffer usada para esa llamada es `DAT_01050d18`, valor `0x86890` en la tabla de instrucciones retenida. El wrapper `0102da70` pasa ese mismo puntero y `param_2 >> 1 = 48` a `0102be4c`, es decir, 48 `int16` contiguos con stride de 2 bytes. No selecciona un canal en el wrapper. En el caller DSP, la ruta ordinaria suma cada par de `int16` antes de escribir el buffer de salida; el formato especial también suma pares y produce salida filtrada antes de llamar al wrapper. Por tanto los valores agregados que llegan al ring son mono en ambas rutas inspeccionadas, no una colección de niveles por canal. La interpretación semántica/identidad física de esas fuentes sigue limitada por la evidencia estática.
- `record_app_main` (`0101b91c`) inicializa el manager mediante `0102ca1c`. Esa función asigna y pone a cero el objeto de 200 bytes, crea un ring buffer de `0xa000` bytes y un stream `010728e0(5, ringbuf)` guardado en `manager+0x18`. La inicialización no equivale a callback activo: el byte `manager+1` parte a cero por el memset, y las rutas productoras exigen sus guards/handles; la ruta AIN abre un handle adicional en `manager+0x58` al ejecutar `0102c02c`. Así, el objeto y el stream del ring se preparan durante el init de la aplicación y pueden existir estando idle, mientras los productores requieren estado/streams activos. Este análisis no observa el valor de una instancia runtime concreta estando idle.

Conclusión del complemento: el anillo recibe magnitudes de samples mono ya combinados a partir de callbacks condicionados por estado; el reporte no puede tratarlo como una señal mic-only, separar Mic/System, ni atribuirle actividad en idle. Para observabilidad por canal, el siguiente cambio tendría que registrar cada canal por separado antes de la suma con un contrato de origen estable, o usar el proveedor de energía con un contrato comprobado; este ring no conserva esos datos.
