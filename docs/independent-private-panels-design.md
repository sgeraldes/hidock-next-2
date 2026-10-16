# CANCELADO: dos paneles privados independientes

Cancelado por instrucción explícita del usuario el 6 de octubre de 2026. Queda cancelado todo plan y preparación de publicación de paneles o HiDock en AWS/DFX5. No reanudar. Los paneles contienen información personal y HiDock es el tomador personal de notas del usuario: permanece local, sin exposición a Internet y sin alojamiento empresarial. El contenido restante es exclusivamente registro histórico, no instrucciones ejecutables ni autorización. No se creó infraestructura, permisos o registros Entra ni se publicaron datos mediante esta propuesta. La visualización privada local o exclusivamente mediante la app se resolverá por separado. Conservar backend local, archivos privados, fuentes y otros trabajos sin cambios.

6 de octubre de 2026. Propuesta local, no implementada ni autorizada para despliegue. Reemplaza la propuesta retirada de Nexo.

## Cuenta verificada

AWS Organizations `list-accounts` y `describe-account` vía perfil ya autenticado `dfx5-master` identificaron `202533512721` como `DFX5-Sandbox-Sebastian-Geraldes`, correo de cuenta `aws+sandbox-sebastian-geraldes@dfx5.com`, estado ACTIVE. STS del perfil `dfx5-dfx5-sandbox-sebastian-geraldes-administratoraccess` devolvió esa cuenta y sesión de Sebastian. Organizations y STS distinguen `613208686219`, `DFX5-Internal-Apps-Dev`. No hay tags de cuenta que añadan otra prueba de propietario. Nombre y correo de Organizations constituyen evidencia independiente del nombre del perfil. No se requiere nueva sesión ni concesión para esas lecturas.

El usuario ubicó Nexo en Internal Apps Dev y rechazó su reutilización. Esta propuesta excluye completamente Nexo aunque se hubieran encontrado recursos similares en otra cuenta. La propuesta previa nunca fue aprobada. No se cambió ningún recurso AWS/Entra.

## Diseño independiente en us-east-1

- Nuevo stack `SebastianPrivatePanelsStack`, nuevo bucket privado con Block Public Access completo, OAC, distribución CloudFront y key group propios. No reutilizar buckets, distribuciones, claves ni secretos de Nexo. El hostname será el `d<id>.cloudfront.net` asignado al crear la distribución; no existe ni puede verificarse todavía. No DNS personalizado en el alcance mínimo.
- Objetos privados en `/panels/releases/<release>/`: dos HTML sanitizados, assets privados y manifest. `/panels/*` exige cookies firmadas CloudFront; `/login/*` solo contiene loader sin datos. API auth en `/auth/*` va a un nuevo HTTP API Gateway y Lambda, sin caché de respuestas de sesión. La Lambda no necesita leer documentos de los paneles.
- Nuevo registro Entra dedicado, de tenant único, para login del sitio. Tenant verificado: `880fbe54-9a00-4675-bb67-30dd98b9eb3f`. Sebastián verificado en Graph: `oid=81284bd3-0a02-4fe3-961d-bb75bf25622d`, UPN `sebastian.geraldes@dfx5.com`, cuenta habilitada. Validar en servidor firma/JWKS, issuer, tenant, audiencia del registro nuevo, expiración y oid exacto. Una sesión de cualquier otro usuario del tenant se deniega.
- SPA usa autorización con PKCE y callback exacto HTTPS del hostname nuevo. No client secret de SPA. El flujo existente de Nexo y su registro no se modifican. Las cookies firmadas propias usan política del host exacto y `/panels/*`, Path `/panels`, Secure/HttpOnly/SameSite=Lax y expiración breve. Logout borra esas cookies; no elimina archivos ya descargados.
- Generar clave de firma exclusiva dentro del proceso de implementación autorizado, guardar privada en un nuevo secreto Secrets Manager y pública en CloudFront. Lambda puede leer solo ese secreto; nunca mostrarlo en logs, artefactos o navegador. CloudWatch con retención corta y sin payloads de datos/token. IAM del publicador limita Put/Get al prefijo del nuevo bucket, sin Delete ni acceso a sitios ajenos. No ALB, NAT, EC2, peering ni apertura de puertos de la PC.

Archivos propuestos en un directorio independiente `research/independent-private-panels/`: `infra/lib/private-panels-stack.ts`, `services/auth/index.mjs`, `web/login/index.html`, `scripts/publish.mjs`, `tests/access.test.mjs`. Son nombres previstos; no se crearon implementaciones en esta tarea. La preparación reutiliza los generadores locales de snapshots, no código de acceso ni stacks de Nexo.

## Datos y actualización

Se publican dos snapshots de lectura: pendientes/tareas profesionales del tablero operativo; Panel Delivery con proyectos, internos, personas, referencias y brief que ya contiene. Campos permitidos y necesarios, no copiar el almacén completo de tareas. Excluir correos completos, credenciales, tokens, audio, transcripciones completas, datos personales innecesarios y acciones que escriben/ejecutan agentes. Audiencia humana exclusiva de Sebastián. Todos los archivos con datos, incluyendo releases anteriores, quedan tras protección del servidor/CDN.

Publicar releases inmutables y hashes; actualizar `current.json` al final para ambos paneles juntos. Conservar release anterior y hacer rollback cambiando manifest. No borrar objetos automáticamente. Mostrar la frescura de cada fuente y preservar timestamps ante fallo; no reciclar el brief del 6 de octubre como evidencia nueva. La PC produce/publica snapshots mientras siga alojando recolectores; lo ya publicado funciona cuando esté apagada. No se crea recurrencia automática sin acordar horario/cadencia.

## Lectura para vix sin asumir principal AWS

Opción mínima inmediata: entregar snapshots revisados a vix mediante el mecanismo de archivos privado ya autorizado, sin endpoint nuevo ni permisos AWS. Eso ofrece contenido fijo, no consultas live.

Opción persistente independiente: nuevo gateway HTTPS de lectura (no acceso directo S3 ni credenciales de Sebastián), con OAuth y scopes definidos: `panels.read`. Registro/audiencia de API independiente de los ID tokens del login; validar access token, issuer, audience, scopes y cliente/sujeto autorizado. Herramientas finitas `get_panel_manifest`, `get_task_snapshot`, `get_delivery_snapshot`, versiones/campos/tamaño limitados. Permiso de ejecución Lambda para GetObject solo del prefijo de snapshots; sin List global, Put/Delete, raw proxy, shell o rutas arbitrarias. No confundir autenticación SSO de Sebastián con identidad de vix.

Si la plataforma de vix soporta MCP Streamable HTTP y OAuth, puede montarse adaptador sobre esas operaciones; la compatibilidad/registro de cliente no están verificados. Antes de crear grants se necesita la identidad y mecanismo real del cliente (client id confiable o sujeto OAuth concreto y soporte de scopes/flujo). Ese es el único dato pendiente de identidad para habilitar vix; no hace falta un principal AWS si accede por OAuth. No habilitar simplemente cualquier aplicación del tenant ni inventar un principal de servicio.

Ampliar a fuentes SaaS live requiere otra lista de herramientas y autorización por fuente. No trasladar `.env`, tokens o secretos locales. HiDock sigue en PC; un gateway de snapshots no habilita transcripción/RAG live. No exponer bearer de Brain ni reutilizar autostart/migraciones del bridge. No publicar correo de otras personas, enviar mensajes o lanzar agentes.

## Coste y aceptación

Uso supuesto: 500 aperturas/mes a 6 MB (3 GB CDN), 30 releases a 6 MB (0,18 GB S3), 120 publicaciones y 1.000 sesiones/lecturas API mensuales, Lambda 256 MB/100 ms, logs limitados. Para servicio serverless de pago por uso y secreto dedicado, reservar USD 1–5/mes como orden de magnitud, sin suponer free tier. No es cotización: confirmar tarifa/región de entrega, plan y consumo antes del despliegue. Si se contrata CloudFront Pro, su tarifa pública es USD 15/mes y sustituye el supuesto CDN de pago por uso; ese escenario sería aproximadamente USD 15–20/mes con este volumen, sujeto a inclusiones/cuotas. No asumir que un plan gratuito es elegible. Excluye licencias Entra, modelos/proveedores, impuestos, desarrollo y MCP con runtime permanente.

Fuentes oficiales de precios consultadas: https://aws.amazon.com/cloudfront/pricing/ ; https://aws.amazon.com/s3/pricing/ ; https://aws.amazon.com/api-gateway/pricing/ ; https://aws.amazon.com/lambda/pricing/ ; https://aws.amazon.com/secrets-manager/pricing/ . El ejemplo oficial de Secrets Manager usa USD 0,40 por secreto/mes y USD 0,05 por 10.000 llamadas; un secreto dedicado y 1.000 lecturas suman aproximadamente USD 0,405/mes antes de otras condiciones regionales/impuestos. Incluido como orden de magnitud en el rango, sin prometer free tier.

Pruebas: anónimo y otro DFX5 no recuperan HTML/JSON/assets/releases; oid correcto accede; token equivocado/expirado deniega; no datos en loader público; CSP sin escrituras; rollback del par; falta de PC conserva snapshot; vix sin scope/cliente permitido deniega; manifest fallido no cambia versión publicada. Validar la cuenta de despliegue con STS+assert `202533512721` antes de cualquier mutación futura. Ninguna prueba live/despliegue se ejecutó aquí.

## Autorización concreta futura, separada

1. Código/preparación local: implementar únicamente los archivos independientes propuestos, sanitizar los snapshots y probar con fixtures. No desplegar ni registrar aplicaciones en esta etapa.
2. Cambios persistentes AWS: crear el stack nuevo en `202533512721/us-east-1`, bucket/OAC/CDN/key group/claves propias/secreto/Lambda/HTTP API/logs e IAM mínimo descritos; publicar solo ambos snapshots privados y habilitar publicación de nuevos releases con rollback, dentro del presupuesto acordado. No DNS ni recursos Nexo.
3. Cambios persistentes Entra: crear registro dedicado de tenant único con callback exacto asignado al CDN y restringir en servidor al oid de Sebastián; sin Directory.Read.All ni permisos de correo. El callback exacto se conoce después de crear la distribución y se revisa antes de registrar/configurar la aplicación.
4. Acceso persistente vix, opcional: tras identificar el cliente real y verificar soporte OAuth, habilitar solamente `panels.read` y las tres operaciones de snapshots; crear recursos/grants específicos necesarios. No permisos AWS atribuidos a vix, no fuentes live ni HiDock remoto. Si no se aprueba este punto, los paneles humanos funcionan igualmente y vix recibe archivos privados según autorización existente.

Esta lista no está aprobada. La autorización permanente del backend/Gemini no se extiende a AWS/Entra, despliegues o nuevas concesiones.
