# Seguimiento del escritor de `0x85280` en H1E 6.3.0

## Resultado

No localicé el instalador ni el target de `0x852a4` en la evidencia estática consultada. El resultado acota la búsqueda a la imagen Zephyr H1E 6.3.0 fijada y al programa Ghidra ya analizado; no demuestra que el instalador sea externo a Zephyr. Sigue siendo posible que la escritura sea indirecta/dinámica, use un alias/copia no recuperada por estas referencias, o provenga de otro componente/runtime.

La dependencia exacta para el siguiente salto es el valor runtime de `*(uint32_t *)0x852a4` después de la inicialización y el cuerpo de código correspondiente a ese valor, con la imagen que lo contiene. Sin ambos no se puede identificar la firma real del proveedor ni diseñar una observación que lo invoque con seguridad. No se justifica agregar un query ni repetir un ensayo acústico.

## Procedencia y método acotado

La imagen es `research/rea/h1e-6.3.0-verified/zephyr-decoded.bin`, SHA-256 `5f8ba521c9cdec6eb25d84825f248543c81e8f0daa96094bdb705a53f7e673ce` (también fijado en `REPORT.md:11`). El log de importación de Ghidra confirma ese archivo, loader raw, base `0x01000000` y lenguaje C-SKY little-endian (`research/rea/evidence/h1e-6.3.0-functions/import.log:46-49`). Esto evita atribuir las referencias a la exportación previa 6.2.5 o a un desplazamiento de header.

Abrí en modo `-noanalysis -readOnly` el proyecto existente `hidock-h1e630-audio` y consulté solo: referencias a las palabras `0x85280..0x852a8`; referencias a celdas de imagen inicializadas que contienen esos valores como little-endian; las instrucciones del tramo `0x0101ee80..0x0101f910`; y los inmediatos/patrones `0x5280`, `0x85280`, `0x852a4`, `0x852a0` y `bseti ...,0x13` en el listing ya cargado. Las salidas temporales quedaron en `%LOCALAPPDATA%\Temp\h1e-provider-writer-query`; no se modificó el proyecto ni se reanalizó/exportó la imagen completa.

El rango de inicialización retenido `[0x82268,0x898e8)` incluye la tabla y la pone a cero durante el arranque (`research/rea/evidence/h1e-6.3.0-integration/exact-startup-memory-ranges.json:34-42`; véase también `REPORT.md:25`). El proyecto Ghidra no mapea esas direcciones RAM como un bloque cargado, así que el escaneo de sus bytes no puede dar el valor posterior al arranque.

## Referencias y accesos observados

El barrido de celdas de imagen encontró diez celdas con referencias de código que contienen el literal `0x85280`:

`0x0101ef94`, `0x0101f070`, `0x0101f454`, `0x0101f4e8`, `0x0101f610`, `0x0101f73c`, `0x0101f818`, `0x0101f8e4`, `0x010201d4` y `0x0102020c`.

También encontró el valor en `0x0110d5e4`, sin xref de código en el programa cargado. Al revisar las instrucciones referenciadas, las celdas usadas por código suministran la base para leer/cargar callbacks de la tabla. Por ejemplo, `0x0101f3a8` carga la celda `0x0101f454` (valor `0x85280`), `0x0101f3aa` guarda esa base en `[sp+0x10]`, y `0x0101f3ac` lee el callback de `[0x85280+4]`; el store es un spill local, no un store al slot. Los demás accesos resueltos en el tramo muestran el mismo patrón de carga/dispatch. Las anotaciones Ghidra `DATA`/`PARAM` que acompañan algunos spills tampoco son escrituras a la tabla.

Para el offset pedido, las únicas instrucciones encontradas que acceden a `0x85280+0x24` son lecturas:

| Dirección | Instrucción | Contexto |
| --- | --- | --- |
| `0x0101efac` | `ld.w r2,(r3,0x24)` | `0x0101efa4`; después llama `jsr r2` en `0x0101efbe` |
| `0x0101eeee` | `ld.w r2,(r3,0x24)` | `0x0101eed8`; después llama `jsr r2` en `0x0101ef46` |

El listing de `0x0101ee80..0x0101f910` no contiene un store a `[base+offset]` que registre un slot. La revisión de los xrefs a cada palabra de la tabla tampoco produjo una escritura en `+0x24`; los accesos al resto de la tabla que aparecen allí son cargas de callbacks, y los `st.w` asociados guardan valores en stack u objetos ajenos. La búsqueda de construcción de dirección no encontró `movi ...,0x5280` ni referencias inmediatas a `0x852a4`/`0x852a0`; los `bseti ...,0x13` que sí aparecen están en secuencias distintas de actualización de bitfields, no en una secuencia observada que construya esta base.

Esto es un resultado negativo acotado a las referencias/literales/instrucciones recuperadas del programa existente. No descarta una instalación por copia/alias o una ruta indirecta que no aparezca como referencia a la base.

## Snapshots retenidos y observación siguiente

Los snapshots ya retenidos no contienen una lectura de memoria del rango `0x85280..0x852a8`. El único log del área donde aparece `0x85280` es una traza de instrucciones de `h1e_vad_load_object`: en `F11aSnapshotTrace630-correct-r0.log:389-390`, el código usa `ld.w r3,(r3,0x40)`, que accede al slot `0x852c0`; no muestra el valor de `0x852a4` ni el contenido de la tabla.

La observación segura mínima, sin añadir una consulta, es pasiva: si ya existe o se obtiene dentro del siguiente volcado aprobado un snapshot post-inicialización, conservar el word en `0x852a4`, su fase/contexto y el mapa de bytes de la imagen que contiene el target. Solo después de resolver el destino se debe inspeccionar su cuerpo para fijar argumentos, buffer/status, ancho de salida y restricciones de ejecución/bloqueo. No llamar el puntero dinámicamente desde un query nuevo con la evidencia actual.

Este addendum deja intacto el checkpoint `REPORT.md`; no incluye operaciones de dispositivo, nueva consulta DSP, cambios de firmware/SDK ni Git.
