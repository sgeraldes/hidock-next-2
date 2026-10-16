# CANCELADO: propuesta anterior de reutilización de Nexo

Cancelado por instrucción explícita del usuario el 6 de octubre de 2026. No reanudar preparación, implementación ni publicación en AWS/DFX5. Los paneles contienen información personal. HiDock es el tomador personal de notas del usuario: permanece local, sin exposición a Internet y sin integración con alojamiento empresarial. El contenido restante es registro histórico, no instrucciones ejecutables ni autorización. No se creó infraestructura, permisos o registros Entra ni se publicaron datos mediante esta propuesta. La visualización privada local o exclusivamente mediante la app se resolverá por separado. Conservar backend local, archivos privados, fuentes y otros trabajos sin cambios.

Fecha: 6 de octubre de 2026. Estado: RETIRADO, nunca aprobado ni desplegado. El usuario corrigió que Nexo pertenece a Internal Apps Dev y rechazó reutilizarlo. Todo el diseño y la lista de autorización que siguen son exclusivamente registro histórico y no deben ejecutarse.

Corrección de cuenta, verificada después de la indicación del usuario mediante AWS Organizations y STS: `202533512721` se llama `DFX5-Sandbox-Sebastian-Geraldes`; `613208686219` se llama `DFX5-Internal-Apps-Dev`. Por tanto, no corresponde renombrar `202533512721` como Internal Apps Dev. Lo erróneo fue asociar los recursos de Nexo inspeccionados al destino de alojamiento autorizado y proponer su reutilización. Las inspecciones anteriores no prueban cuál es el despliegue productivo de Nexo al que se refiere el usuario; no se investigará ni modificará Nexo para este trabajo.

La cuenta personal está identificada; no hay autorización de despliegue. El reemplazo independiente se describe en `independent-private-panels-design.md`. Ningún host, stack, bucket, key group, secreto, permiso o registro Entra de Nexo forma parte del reemplazo.

## Resultado

Se pueden alojar los dos paneles existentes con acceso exclusivo de Sebastian reutilizando S3, CloudFront, Entra/MSAL y el servicio de firma de Nexo. Es necesario añadir autorización de identidad en el servidor y un prefijo protegido independiente. Subirlos bajo `/app/` con la autorización actual permitiría acceder a otros usuarios DFX5 autorizados.

El alojamiento estático puede funcionar con la PC apagada. Su actualización seguirá dependiendo de Workstation mientras los recolectores y el publicador permanezcan allí. Un conector de herramientas remoto es una entrega separada: hay clientes reutilizables, pero no se verificó un servicio remoto ya autenticado y listo para conectar. HiDock sigue siendo local.

## Evidencia y componentes existentes

| Componente | Archivo o recurso inspeccionado | Implicación |
|---|---|---|
| Sitio Nexo | `G:\Code\dfx5-intranet\infra\cdk\lib\nexo-site-stack.ts` | `/app/*` usa trusted key group y S3 OAC; el loader público no contiene los datos de los paneles. |
| Identidad y cookies | `G:\Code\dfx5-intranet\services\auth-svc\index.mjs` | `jwtVerify` verifica firma, issuer y audience; el ALLOWLIST admite dominios. Cookies actuales Path `/app`, política recurso `/app/*`. |
| Rutas y permisos | `G:\Code\dfx5-intranet\infra\cdk\lib\nexo-api-stack.ts` | Existe AuthSession, acceso al secreto de firma y API Gateway. Las nuevas rutas deben usar la estructura NestedStack existente: el stack principal tuvo exceso de recursos. |
| Distribución | CloudFront `E1O22LQJA89F7R`, dominio `nexo.dfx5.com` | Se puede añadir un comportamiento aislado sin DNS nuevo. No se verificó el plan tarifario contratado. |
| Origen | `nexositestack-sitebucket397a1860-vt5xgs9ipbnd` | Block Public Access completo; acceso a través de OAC. |
| Publicación existente | DeployApp y deployment raíz en `nexo-site-stack.ts` | DeployApp publica `app-dev` con prune; el deployment raíz también usa prune y solo excluye `app/**`, `app-dev/**`, `app-green/**`, `app-prev/**`. Deben excluirse explícitamente los nuevos prefijos privados y del loader o una publicación posterior podría borrarlos. |
| Panel completo | `G:\Code\dfx5-panel-delivery\site\index.html` | Datos embebidos; acciones, issues, riesgos y decisiones. Tiene estado local del navegador que debe deshabilitarse para una versión estrictamente de lectura. |
| Tablero operativo | `G:\Code\dfx5-sdm-ops\coverage\phone.html` | El original conecta con operaciones locales y puede modificar tareas. Publicar la copia de lectura preparada, no el original operativo. |
| Copias preparadas | `research/private-dashboard-preview/01-pendientes-tareas.html`, `02-panel-delivery.html`, `prepare.cjs` | Exportación con campos permitidos y eliminación de patrones de secretos. Requiere revisión final de interacción y dependencias antes de publicar. |

Los HTTP 403/404 de CloudFront actualmente se convierten en loader público HTTP 200. Las pruebas de denegación deben verificar ausencia de contenido protegido, no solamente el código HTTP. La autenticación interactiva del futuro flujo privado aún no se probó.

## Cambio mínimo propuesto

1. Añadir comportamiento CloudFront GET/HEAD para `/personal-panels/*`, con el key group existente, OAC y cabeceras de seguridad. Colocar allí HTML, JSON, manifest y cualquier asset privado. No ampliar la política existente de `/app/*`. Añadir `personal-panels/**` y `personal-panels-login/**` a las exclusiones del deployment raíz con prune; comprobar el resto de deployments antes de publicar.
2. Añadir `POST /auth/personal-panels/session`. Implementarlo como handler separado en `services/personal-panels-auth/index.mjs` y recursos en NestedStack, reutilizando la validación JWT y firma existentes sin cambiar la decisión de acceso de Nexo. Comprobar issuer/tenant, audience y el `oid` exacto de Sebastian; email solo como referencia secundaria. Resolver y confirmar ese identificador mediante una lectura autorizada de identidad; no adivinarlo.
3. Emitir las tres cookies firmadas CloudFront con política del host exacto y `/personal-panels/*`, Path `/personal-panels`, Secure, HttpOnly y SameSite=Lax. TTL corto configurable, por ejemplo una hora. Reutilizar el secreto existente con grant de lectura solo para esta función; nunca entregarlo al navegador. La sesión existente de Nexo no debe abrir estos paneles.
4. Añadir logout específico que borre esas cookies. Añadir un loader sin datos en `/personal-panels-login/`, que reutilice MSAL y una URL de retorno ya registrada si el flujo existente lo permite. Verificar los redirects registrados antes de elegir callback; un callback nuevo requeriría autorización adicional en Entra.
5. Aplicar CSP y eliminar conexiones, formularios y acciones operativas de las copias. No incluir tokens API, datos de autenticación, audio ni transcripciones completas. Ambos paneles mostrarán fecha real de cada fuente y el error/antigüedad de recolectores fallidos.

Archivos de implementación previstos: los dos stacks citados; el nuevo handler; un loader privado de autenticación en el prototipo Nexo; `scripts/publish-personal-panels.py` como publicador separado; ajustes de preparación en `research/private-dashboard-preview/prepare.cjs`. Estos nombres son propuesta, no archivos implementados.

## Actualización, publicación y rollback

- Ejecutar los recolectores existentes en Workstation; preparar ambas copias desde fuentes verificadas. No convertir una fecha de exportación en fecha de frescura de una fuente. El brief manual del 6 de octubre debe regenerarse con evidencia nueva, no cambiar solo su fecha.
- Generar un release con identificador temporal, ambas páginas y hashes. Validar archivos, escaneo de secretos, enlaces, carga visual y eliminación de acciones. Conservar el ZIP/release previo antes de cambiar nada.
- Publicar únicamente en `/personal-panels/releases/<release>/` con permiso Put/Get limitado al prefijo. Cambiar `current.json` al final para que apunte al par de páginas del mismo release. El loader autenticado resuelve ese manifest; caché corta del manifest e inmutable para releases.
- Revertir cambiando solo el manifest al release anterior. No usar `sync --delete`, prune ni borrar artefactos de Nexo. Definir retención de releases de forma explícita antes de cualquier limpieza.
- Un refresco fallido conserva el release anterior y comunica qué fuentes están desactualizadas. Separar lectura de fuentes, generación y publicación para que un fallo no deje medio tablero publicado.

## Puentes y herramientas reutilizables

| Fuente | Reutilización comprobada en código | Qué falta para uso remoto |
|---|---|---|
| Kantata | `G:\Code\Kantata-Integration\mcp_server\server.py`: FastMCP, seis workflows; `mcp.run()` sin transporte remoto configurado. SDM tiene `scripts/kantata*_pull.py`. | Transporte HTTP autenticado, contrato y despliegue; configurar el proveedor live sin trasladar archivos de credenciales. El módulo crea logs e inicializa provider al importar: no se ejecutó en esta inspección. |
| BambooHR | `G:\Code\bamboo-mcp\README.md` documenta herramientas; SDM `scripts/bamboo_pull.py` es un cliente real reutilizable. | No se localizó implementación de servidor dentro de los archivos visibles del repo Bamboo. No afirmar que ya hay endpoint HTTP ni trasladar `.env`. |
| Graph/Outlook | `G:\Code\dfx5-sdm-ops\scripts\graph_pull.py` | Autenticación de servicio o delegada aprobada, privilegios de lectura y política de acceso. Excluir `graph_send.py`. |
| Delivery Central/AWS | `scripts/dc_pull.py` y clientes actuales | Identidad autorizada propia del ejecutor; no atribuir a vix los permisos AWS de Sebastian. |
| HiDock | `scripts/hidock_bridge.mjs`, API Brain y `apps/electron/scripts/backend-client.mjs` | Workstation encendida y API accesible por un puente autorizado. El bridge puede arrancar una aplicación instalada y preparar esquema si falta backend: no reutilizar ese arranque en el gateway. Fallar cerrado sin backend; no migrar ni reiniciar automáticamente. |
| Tableros locales | `coverage/server.py` y `coverage/task_server.py` | No exponerlos: el primero permite escritura y CORS amplio; el segundo incluye operaciones que lanzan agentes. No son gateways remotos seguros. |
| Contrato portable | `research/sdm-ops-portable/src/contracts.mjs` y `export-manifest.json` | Es un scaffold con fixtures, no un servicio remoto desplegado o autenticado. |

Primera entrega de herramientas: fachada de lectura en Workstation que llama clientes existentes mediante nombres y argumentos permitidos, con límites de tamaño y tiempo. No ofrece shell, filesystem arbitrario, escrituras ni envío de mensajes. La ejecución delegada actual puede usar Workstation sin atribuir a vix una identidad AWS.

Entrega remota posterior: gateway MCP Streamable HTTP con OAuth, audience específica y scopes de lectura; validar identidad en cada llamada. Publicar solamente herramientas aprobadas y limitar campos profesionales de personal. Secretos y SDK de las fuentes permanecen en el servidor con permisos específicos y logs sin payloads sensibles. El cliente remoto necesita su propia autenticación y registro de confianza; no basta alojar el HTML.

Las fuentes SaaS y AWS son portables en principio, condicionado a su autorización/runtime. HiDock no lo es sin mover biblioteca, audio, base de datos y runtime, lo cual queda fuera del diseño. Alternativas: snapshots de metadatos privados en S3, o puente saliente desde Workstation con operaciones finitas de lectura. Ninguna habilita transcripción/RAG en nube por sí misma. No publicar el bearer propietario de Brain ni abrir puertos entrantes. La clase local de grants scoped todavía no está provisionada/integrada como acceso productivo remoto.

## Coste incremental orientativo

Supuestos personales: 500 aperturas/mes, 6 MB por apertura (aprox. 3 GB de salida), 30 releases retenidos de 6 MB (0,18 GB), hasta 120 publicaciones/mes, 1.000 sesiones API/mes y Lambda 256 MB durante 100 ms por sesión. Sin ALB, NAT Gateway, EC2, provisioned concurrency ni nuevo dominio. S3/API/Lambda serían pequeñas fracciones de dólar; salida CDN y logs dominan. Reservar **USD 1–5/mes incrementales** como orden de magnitud bajo esos supuestos, no cotización ni coste total de Nexo. No incluye ejecución de un MCP remoto, licencias Entra, providers/modelos, impuestos ni configuración de seguridad existente.

CloudFront ofrece actualmente planes de tarifa plana Free y Pro (Pro USD 15/mes), además de opciones pay-as-you-go. No se confirmó el plan de esta distribución, uso compartido o elegibilidad de cuotas gratuitas. No cambiar de plan por este diseño; verificar plan y consumo antes de aprobar presupuesto. El rango incremental presupone reutilizar la distribución sin contratar un plan nuevo.

Fuentes oficiales consultadas el 6 de octubre de 2026: [CloudFront](https://aws.amazon.com/cloudfront/pricing/), [S3](https://aws.amazon.com/s3/pricing/), [API Gateway](https://aws.amazon.com/api-gateway/pricing/), [Lambda](https://aws.amazon.com/lambda/pricing/). Las tarifas, cuotas y regiones de entrega pueden cambiar el resultado.

## Criterios de aceptación

- Anónimo, token inválido/expirado, tenant incorrecto y otro usuario DFX5: sin HTML/JSON/assets privados. Probar URL directa, manifest y release antiguo; una respuesta 200 de fallback no debe contener datos.
- Sebastian: obtiene sesión, abre ambos paneles y assets; logout/expiración impiden nuevas descargas. Las páginas ya descargadas no pueden retirarse del navegador mediante logout.
- Cookies de `/app` no abren `/personal-panels`; sesión privada no amplía acceso general. Comparar Nexo antes/después para detectar regresión.
- Assets privados jamás servidos desde rutas públicas; secreto/tokens ausentes en HTML, JS, storage y logs. CSP y renderer sin llamadas de escritura.
- Una publicación parcial no cambia `current.json`; rollback recupera el par anterior. Pruebas no usan `DeleteObject` sobre el sitio.
- Fuentes con fallo conservan su timestamp anterior. Actualización de cuatro fuentes no marca todas como frescas.
- Gateway: usuario no autorizado y herramienta no permitida fallan; argumentos no permiten ejecutar comandos. HiDock ausente devuelve unavailable sin arrancar ni migrar. Fuentes remotas se prueban por separado con lecturas inofensivas y sus autorizaciones reales.

## Única lista de autorización pendiente para implementar y publicar

1. Autorizar resolver y fijar la identidad Entra exacta de Sebastian, y añadir exclusivamente la ruta de sesión/logout personal y su loader. Solo si se necesita un callback nuevo, incluir el cambio concreto de redirect en Entra tras revisar la configuración existente.
2. Autorizar el comportamiento CloudFront `/personal-panels/*`, objetos de ese prefijo S3, exclusiones de ambos prefijos nuevos en el deployment raíz con prune y permisos mínimos de publicación/firma; reutilizar distribución, OAC, key group y secreto existentes, sin cambios DNS, sin ampliar acceso DFX5 ni modificar contenido de Nexo.
3. Autorizar publicar únicamente las dos copias sanitizadas de lectura, probar exclusión de otros usuarios y habilitar el publicador de releases con conservación/rollback, dentro del presupuesto incremental acordado.
4. Si se desea además el conector remoto, autorizarlo como alcance explícito separado: runtime/endpoint OAuth, identidad del cliente y herramientas de lectura por fuente. No incluye HiDock remoto, permisos de escritura, agentes, audio ni migración de credenciales. La publicación de los paneles no depende de aprobar esta cuarta parte.

Esta lista define una propuesta revisable; no representa autorización obtenida ni acciones ejecutadas. El permiso permanente de arrancar el backend existente sin migraciones y transcribir pendientes del 5 de octubre con Gemini no se extiende a despliegues, IAM, Entra o conectores nuevos.
