# APIs de facturación VERI*FACTU para un autónomo

**Revisado:** 3 nov 2026. Todos los datos de este documento proceden de las páginas públicas de los proveedores en esa fecha (las URL están en cada sección). No se dio de alta ninguna cuenta. "Sin confirmar" significa que las páginas públicas no lo decían.

**Perfil:** autónomo en España, ~5–30 facturas B2B al año a empresas españolas. Líneas de servicio con IRPF del 7 %, bienes refacturados a precio de coste sin IRPF, IVA del 21 % y, a veces, un importe ya pagado.

**Restricción:** no construimos un SIF propio (no calculamos huellas ni encadenamos registros, no hay SOAP con la AEAT ni declaración responsable). El proveedor tiene que ser el SIF: envía el registro de facturación a la AEAT y genera el PDF de la factura con el QR VERI*FACTU.

## Recomendación: BeeL

Usar **BeeL** (beel.es) detrás de un servidor MCP propio y ligero.

1. **IRPF por línea.** Cada línea tiene su propio `irpf_rate`. En una misma factura, los servicios llevan 7 y los bienes, 0. De las API revisadas, BeeL es la única que documenta esto por línea.
2. **Es un SIF completo.** El ciclo borrador → emisión, el envío a la AEAT y el PDF con el QR están dentro de BeeL. También aporta la declaración responsable. Nuestro código no envía ningún registro fiscal.
3. **Sandbox gratuito e ilimitado.** Hace falta registrarse, pero no una tarjeta. Las claves de prueba (`beel_sk_test_…`) van al entorno de *pruebas* de la AEAT, y el prefijo de la clave elige el entorno.
4. **Buena API.** Especificación OpenAPI 3.0.3 (v1.9.0), claves de idempotencia, series con `initial_number` configurable (podemos continuar en 2026003), un endpoint de PDF, exportación a Excel y un SDK para Node.
5. **Coste.** Producción cuesta 15 €/mes en el plan anual (180 €/año + IVA) o 19 €/mes en el mensual. Solo se paga desde que se activa el NIF en producción. El cupo de 250 facturas/mes es irrelevante con este volumen.

**¿El MCP de BeeL ya lo cubre todo?** Casi, pero no con la seguridad suficiente para usarlo solo:

- `@beel_es/mcp` (local, con clave API) y `https://mcp.beel.es/mcp` (remoto, OAuth) exponen unas 129 herramientas de la API: crear, emitir, PDF, listar y más.
- **No pide confirmación humana** antes de emitir. Emitir es irreversible.
- **No tiene la regla de "sandbox salvo que se pida producción expresamente".** Decide la clave.
- **No aplica "IRPF solo en servicios".** Una línea que omite `irpf_rate` *hereda el valor por defecto de la empresa*, lo que es una trampa.
- **No modela lo ya pagado.** BeeL no tiene un campo de pago parcial.

Por eso nuestro servidor puede ser pequeño. Se encarga de los borradores locales, la comprobación de importes, la regla de IRPF solo en servicios, los controles de confirmación y de producción y la continuidad de la numeración. BeeL hace el trabajo fiscal. Para lo que quede fuera de nuestras 4 herramientas (clientes, facturas rectificativas, anulaciones), se puede añadir el MCP de BeeL junto al nuestro.

**Una opción más barata que conviene valorar:** la aplicación gratuita VERI*FACTU de la AEAT, que ya se usa para la 2026001 y la 2026002, cuesta 0 €. Basta para 5–30 facturas al año introducidas a mano. Los ~180 €/año de BeeL pagan la automatización desde Claude, no el cumplimiento. Ver "Decisiones pendientes" más abajo.

## Comparativa

| | **BeeL** | **Invopop** | **Verifacti** | **B2Brouter** |
|---|---|---|---|---|
| Qué es | SIF de facturación con API | Plataforma de facturación con documentos GOBL y flujos de trabajo | Solo API de *registro* VERI*FACTU | Plataforma de facturación electrónica con API |
| Precio para 5–30 facturas/año | Sandbox 0 €. Producción 180 €/año (anual) o 19 €/mes + IVA | Plan Dev 0 €/mes con 200 "Pops"/mes; la primera app de administración pública (España), gratis. Probablemente 0 € (cálculo propio) | Unos 2,9 €/NIF/mes (según un listado de terceros; su propia página de precios no muestra cifras) + 2,90 € de firma electrónica | App web: gratis hasta 24 transacciones/año, o 110 €/año. API: venta comercial ("desde 348 €" + 800 € de alta) |
| Retención de IRPF | ✅ por línea, `irpf_rate` (0, 1, 2, 7, 15, 19…) | ⚠️ GOBL tiene `IRPF` como impuesto retenido por línea; sin confirmar con el complemento VERI*FACTU | ❌ no hay campo; la retención queda fuera del registro | ⚠️ solo a nivel de factura: `withheld_percent` / `amounts_withheld` |
| Sandbox | ✅ gratuito, ilimitado, entorno de pruebas de la AEAT; requiere registro, sin tarjeta | ✅ espacio de trabajo de sandbox, preproducción de la AEAT; requiere registro | ✅ empresa de prueba gratuita, entorno de pruebas de la AEAT; requiere registro | ✅ `api-staging.b2brouter.net`; requiere registro |
| Documentación de la API | ✅ OpenAPI 3.0.3, guías, catálogos de errores y de reglas, llms.txt | ✅ documentación en Mintlify con algunas incoherencias (PUT frente a POST) | ✅ referencia al estilo Swagger + ~30 ejemplos JSON; no indica el host ni la cabecera de autenticación | ✅ OpenAPI 3.0.1 (readme.io); autenticación poco clara (cabecera o basic) |
| PDF + QR | ✅ PDF con QR, generado por BeeL | ⚠️ paso de PDF en el flujo de trabajo; el QR es solo una URL ("we do not provide the QR code image") | ❌ sin PDF; QR solo en base64 | ⚠️ genera PDF; QR en la respuesta del informe fiscal; QR en el PDF sin confirmar |
| Autenticación | `Authorization: Bearer beel_sk_test_…/live_…` | `Authorization: Bearer <JWT>` | Clave API por NIF (no indica la cabecera) | `X-B2B-API-Key` |
| SDK | SDK para Node; CLI; MCP; Python mediante REST directo | No se encontró ninguno | Ninguno (ejemplos de código en muchos lenguajes) | Solo PHP |
| Exportación | Exportación `.xlsx` (resumen o por línea); listado JSON paginado; ZIP de PDF | No se encontró | Exportación XML por periodo | Listado de facturas, libros registro, guía de "export history" |
| Numeración | BeeL asigna el número al emitir, a partir de una serie; `initial_number` configurable | Series de secuencia con `start` | Quien llama envía `serie` + `numero` | Quien llama envía `number` |
| ¿Pensado para un autónomo? | ✅ sí ("self-employed professionals in Spain") | ⚠️ en principio sí, pero con una configuración pesada (flujos de trabajo, alta del emisor) | ⚠️ sí, pero tendríamos que generar nosotros la factura | ⚠️ la app web sí; la API se vende a integradores |

**También vistos, sin evaluar a fondo:**
- **fiskaly SIGN ES:** orientado a fabricantes de TPV y ERP (ISV). Sin precio público; la referencia de la API de SIGN ES no se cargaba; el sitio para desarrolladores dice que su documentación está "outdated".
- **Quaderno:** su API VERI*FACTU es una beta a la que hay que apuntarse por correo electrónico.

## Notas por proveedor

### BeeL
Fuentes: https://beel.es/precios, https://docs.beel.es/, https://docs.beel.es/api/openapi (especificación leída directamente), https://docs.beel.es/verifactu/testing-in-sandbox, https://docs.beel.es/guides/series-and-numbering, https://docs.beel.es/guides/amounts-and-rounding, https://docs.beel.es/guides/bulk-operations-and-exports, https://docs.beel.es/mcp/tools, https://github.com/beel-es/beel-mcp

**Precio**
- Sandbox: "0 € para siempre", sin tarjeta.
- Plan API: 19 €/mes, o 15 €/mes facturados como 180 €/año, para un NIF. Incluye 250 facturas/mes; a partir de ahí, 0,01 € cada una. IVA no incluido, sin permanencia. "Solo pagas al activar tu NIF en producción."
- La documentación dice que hace falta un plan API para tener acceso completo a la API. Da a entender que la API del sandbox funciona con el plan gratuito, pero no lo dice expresamente. Hay que comprobarlo después del registro.

**URL base y autenticación**
- La URL base es `https://app.beel.es/api` para los dos entornos. `beel_sk_test_*` significa sandbox y `beel_sk_live_*`, producción.
- Las claves tienen permisos acotados (`invoices:write`, `invoices:read`…).
- Una clave se puede comprobar con `GET /v1/me/identity`.

**Endpoints que usamos** (bajo la ruta de la empresa; las rutas planas `/v1/invoices` están obsoletas y se retiran el 9 dic 2026):
- `POST /v1/companies/{company_id}/invoices` con `options.issue_directly: true` crea y emite en una sola llamada. Con `Idempotency-Key`, un reintento en las 24 h siguientes repite la primera respuesta.
- `GET /v1/companies/{company_id}/invoices/{invoice_id}/pdf` devuelve una `download_url` prefirmada válida durante 5 min. Espera hasta 10 s; si el PDF no está listo, devuelve `202` con `Retry-After`.
- `POST /v1/companies/{company_id}/series` fija `format`, `counter_reset` e `initial_number`.

**IRPF**
- `lines[].irpf_rate`. Si se omite, la línea hereda el valor por defecto de la empresa, así que siempre lo enviamos de forma explícita: 7 en los servicios y 0 en los bienes.
- Las facturas F2 (simplificadas) no admiten IRPF.

**Numeración y fechas**
- `issue_date` no es un dato de entrada; BeeL la fija en el día de emisión. Las operaciones de días anteriores usan `operation_date`.
- El número es nulo en los borradores y se asigna al emitir.
- Cuando una serie ya ha emitido alguna factura, `format`, `counter_reset` e `initial_number` quedan bloqueados.

**PDF.** El PDF incluye el QR VERI*FACTU. Un borrador no tiene PDF fiscal.

**Ya pagado.** No hay ningún campo. Marcar como pagada es todo o nada (`PUT …/status`). Ponemos el importe ya pagado y el pendiente en `notes` (máx. 1000 caracteres).

**MCP**
- El remoto se añade con `claude mcp add --transport http beel https://mcp.beel.es/mcp` (OAuth). El local, con `npx -y @beel_es/mcp` y `BEEL_API_KEY`.
- Hace comprobaciones previas en local, pero no tiene ningún paso de confirmación.

### Invopop
Fuentes: https://invopop.com/pricing, https://invopop.com/pricing.md, https://docs.invopop.com/apps/verifactu-spain.md, https://docs.invopop.com/guides/countries/es-verifactu, https://docs.invopop.com/guides/countries/es-verifactu-supplier, https://docs.invopop.com/guides/series.md, https://docs.invopop.com/api-ref/authentication.md, https://docs.gobl.org/regimes/es

**Precio**
- Plan Dev, 0 €/mes: 200 Pops, la primera app de administración pública gratis y un usuario. Pro cuesta 500 €/mes.
- Por factura: unos 2–3 Pops (XML + envío + PDF). Alta del emisor: 100 Pops. Según nuestros propios cálculos, nuestro volumen cabe en el plan gratuito; Invopop no lo afirma.

**Puesta en marcha.** Es pesada:
- Conectar la app VERI*FACTU.
- Dar de alta al emisor con un acuerdo firmado y un documento de identidad.
- Montar un flujo de emisión (secuencia → firma → XML → envío → PDF).
- Las facturas son documentos JSON GOBL que se guardan como entrada de un silo y después se procesan como un trabajo de transformación.

**Carencias**
- No hay ningún ejemplo de IRPF en la documentación de VERI*FACTU.
- El QR es solo una URL ("we do not provide the QR code image itself").
- No se encontró ningún SDK.

**Merece una segunda mirada** si el coste cero importa más que el esfuerzo de configuración. Habría que probar en el sandbox cómo trata el IRPF por línea.

### Verifacti
Fuentes: https://www.verifacti.com/, https://www.verifacti.com/precios, https://www.verifacti.com/docs, https://www.verifacti.com/desarrolladores/ejemplos, https://www.verifacti.com/guia-rapida, https://apps.odoo.com/apps/modules/19.0/verifacti_api

**Qué es**
- Solo una API de registro. Genera el registro (XML, encadenamiento de huellas), lo envía a la AEAT y devuelve el QR en base64. **No** genera la factura ni el PDF.
- La retención de IRPF no forma parte del registro ("la retención no debe indicarse en absoluto").

**Por qué se descarta.** Tendríamos que generar nosotros el documento legal de la factura y colocar el QR. Eso supone construir la parte de facturación de un SIF, algo que el proyecto decidió no hacer.

**Otros datos**
- Es, con diferencia, la más barata: unos 2,9 €/NIF/mes, según un listado de terceros; la página de precios de Verifacti no muestra cifras.
- Empresa de prueba gratuita que llama al entorno de pruebas de la AEAT.
- Quien llama aporta `serie`/`numero`. `fecha_expedicion` tiene que ser la de hoy.

### B2Brouter
Fuentes: https://www.b2brouter.net/es/api-verifactu/, https://www.b2brouter.net/es/precios/, https://www.b2brouter.net/es/precios-productos-integrados/, https://docs.b2brouter.net/es/developers/overview/, https://developer.b2brouter.net

**Precio**
- App web: el plan Basic es gratuito pero tiene un límite de 24 transacciones/año, y las facturas recibidas y las declaraciones de impuestos cuentan para ese límite. El plan Professional cuesta 110 €/año + IVA.
- API: se vende mediante planes de integración ("Solicita más información"; la calculadora menciona "desde 348 EUR" y 800 € de alta).

**Carencias**
- La retención solo se aplica a nivel de factura, lo que no encaja bien con "IRPF solo en servicios".
- Solo hay SDK para PHP.
- La documentación de autenticación es contradictoria.

### fiskaly SIGN ES
Fuentes: https://www.fiskaly.com/signes/verifactu-for-in-house-teams, https://developer.fiskaly.com/sign-es/integration_process

- Está orientado a ISV y fabricantes de TPV. Precio bajo presupuesto.
- No se encontró información sobre el IRPF.
- La referencia de la API no se cargaba, y el aviso del sitio para desarrolladores dice que la documentación ya no se mantiene.

## Calendario legal (afecta a la urgencia, no a la elección)

- **En vigor:** el RDL 15/2025 hace obligatorio VERI*FACTU el 1 ene 2027 para los contribuyentes del impuesto sobre sociedades y el **1 jul 2027** para el resto, autónomos incluidos.
- **Anunciado, pero no en vigor:** el 5 oct 2026, Hacienda anunció un nuevo aplazamiento hasta **octubre de 2028**, para hacerlo coincidir con la factura electrónica B2B obligatoria. Según la prensa, **todavía no se ha publicado en el BOE**, así que hasta entonces siguen vigentes las fechas de 2027. Fuentes:
  - https://www.infoautonomos.com/blog/retraso-verifactu/
  - https://emprendedores.es/gestion/aplazamiento-verifactu-2028/
  - https://elderecho.com/hacienda-pospone-a-octubre-de-2028-la-implantacion-de-verifactu-para-empresas-y-autonomos
  - El aviso de la guía VERI*FACTU de Invopop (citada más arriba)
- **Consecuencia:** ya se puede usar un SIF VERI*FACTU de forma voluntaria. Nada obliga a contratar un plan de pago antes de mediados de 2027, como pronto.

## Decisiones pendientes

1. **Pagar BeeL o seguir con la app gratuita de la AEAT.** La app de la AEAT cuesta 0 €. BeeL cuesta ~180 €/año + IVA y permite emitir desde Claude. El trabajo en el sandbox no cuesta nada en ningún caso.
2. **No usar dos sistemas en la misma serie.** En cuanto BeeL emita la 2026003, deja de emitir en la app de la AEAT (o usa allí otra serie). Dos SIF en la misma serie acabarán chocando.
3. **Continuar la serie en un SIF nuevo.** Continuar la 2026001 y la 2026002 (app de la AEAT) con la 2026003 (BeeL) mantiene la serie correlativa. Confirma con tu gestor que cambiar de programa a mitad de serie no plantea problemas en tu caso.
