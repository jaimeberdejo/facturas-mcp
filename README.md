# facturas-mcp

Servidor MCP (stdio) para preparar y emitir facturas españolas con VERI*FACTU a través de un proveedor externo que ya es un SIF conforme ([BeeL](https://beel.es)).

Este servidor **no** es un SIF por sí mismo: no calcula huellas ni encadena registros, no se comunica por SOAP con la AEAT y no presenta declaración responsable. De todo eso se encarga BeeL. Lo que aporta este servidor es:

- borradores locales
- importes exactos
- IRPF solo en los servicios
- el importe ya pagado
- un control de confirmación
- sandbox por defecto
- una serie que nunca reutiliza un número

La comparativa de proveedores y los motivos para elegir BeeL están en [RESEARCH.md](RESEARCH.md).

## Herramientas

| Herramienta | Qué hace | ¿Llama al proveedor? |
|---|---|---|
| `crear_borrador` | Valida el cliente y las líneas, y calcula la base, el IVA, el IRPF (solo en las líneas de servicio), el total, lo ya pagado y el importe pendiente. Guarda un borrador local y devuelve un resumen legible. | No |
| `emitir_factura` | Emite un borrador con el siguiente número de la serie. Exige `confirm: true`. Usa el sandbox salvo que el servidor tenga `FACTURAS_ENV=production`. | Sí |
| `descargar_pdf` | Descarga el PDF (con el QR VERI*FACTU) de una factura emitida y lo guarda en la carpeta local de PDF. | Sí |
| `listar_facturas` | Lista los borradores y las facturas emitidas: número, fecha, cliente, total y estado. | No |

Tipos de línea:

- `servicio`: un servicio profesional. Lleva IRPF, un 7 % por defecto.
- `bien`: bienes que se refacturan a precio de coste. Nunca llevan IRPF.

Los dos llevan IVA al 21 % salvo que la línea indique otro tipo (también se admiten el 10 % y el 4 %).

## Reglas de seguridad

1. **No se emite nada sin `confirm: true`.** Tiene que ser el booleano `true`; se rechazan valores como "sí" o `1`. La descripción de la herramienta indica a Claude que solo lo ponga después de que confirmes expresamente ese borrador concreto.
2. **Sandbox por defecto.** Para producción hace falta `FACTURAS_ENV=production` en la configuración del servidor. Un argumento de la herramienta, por sí solo, nunca llega a producción.
3. **Producción exige una segunda confirmación.** Cuando el servidor está en producción, cada llamada a `emitir_factura` debe indicar además `entorno: "production"`. Así, quien llame creyendo que está en pruebas no puede emitir una factura real.
4. **Las claves van ligadas al entorno.** En sandbox, el adaptador de BeeL rechaza cualquier clave que no empiece por `beel_sk_test_`. En producción exige `beel_sk_live_`. BeeL usa la misma URL para los dos entornos y es la clave la que decide, así que esta comprobación es lo que impide que el sandbox acabe en producción.
5. **El mock no puede funcionar en producción.** Con `FACTURAS_ENV=production` y `FACTURAS_PROVIDER=mock`, el servidor se detiene al arrancar.
6. **Los números nunca se reutilizan.** Las facturas se emiten de una en una. El número se reserva antes de llamar al proveedor, y lo que ocurre con él depende de la respuesta:
   - **Rechazo** (error de validación o de autenticación; no se ha registrado nada): el número se libera y la serie sigue siendo correlativa.
   - **Resultado desconocido** (tiempo de espera agotado, error 5xx): el número sigue reservado para ese mismo borrador y no se puede emitir ningún otro hasta que lo reintentes. El reintento busca la factura por el id del borrador (`external_ref` en BeeL), así que nunca puede crear un duplicado.
7. **Sandbox y producción nunca comparten números.** Cada entorno tiene su propia carpeta de datos.
8. **Ningún secreto en el repositorio.** Los datos del emisor y las claves están en `~/.config/facturas-mcp/.env`, fuera del repositorio. Solo se versiona `.env.example`, con valores de ejemplo. `data/` y `.env` están en `.gitignore`.

## Instalación

Requiere Node.js 22 o posterior.

```sh
npm install
npm run build
npm test
```

Configuración: copia el ejemplo fuera del repositorio y rellénalo.

```sh
mkdir -p ~/.config/facturas-mcp
cp .env.example ~/.config/facturas-mcp/.env
chmod 600 ~/.config/facturas-mcp/.env
```

El servidor lee, de mayor a menor prioridad:

1. las variables de entorno reales;
2. el fichero indicado en `FACTURAS_CONFIG_FILE` (por defecto, `~/.config/facturas-mcp/.env`);
3. un `.env` en la raíz del repositorio (excluido en `.gitignore`).

| Variable | Valor por defecto | Significado |
|---|---|---|
| `FACTURAS_ENV` | `sandbox` | `sandbox` o `production`. Cualquier otro valor detiene el servidor. |
| `FACTURAS_PROVIDER` | `mock` | `mock` (nada sale de tu equipo) o `beel` |
| `FACTURAS_NUMERO_INICIAL` | `AAAA001` del año en curso (p. ej. `2026001`) | Primer número que se emite, con formato `AAAANNN`. Si continúas una serie que ya tiene facturas, indícalo expresamente: por ejemplo, si ya emitiste la 2026001, pon `2026002`. Subirlo hace avanzar la serie; nunca retrocede. Con el año nuevo, la serie vuelve a empezar en `AAAA001`. |
| `FACTURAS_IRPF_POR_DEFECTO` | `7` | % de IRPF en las líneas de servicio |
| `FACTURAS_EMISOR_*` | ninguno | Nombre, NIF, dirección, IBAN y correo electrónico del emisor. El IBAN figura en la factura como forma de pago por transferencia. |
| `BEEL_API_KEY` | ninguno | `beel_sk_test_…` para el sandbox |
| `BEEL_COMPANY_ID` | ninguno | UUID de tu empresa en BeeL |
| `BEEL_SERIES_ID` | serie por defecto de la empresa | UUID de la serie STANDARD |
| `FACTURAS_DATA_DIR` | `<repo>/data` | Borradores y estado de la serie, con una subcarpeta por entorno |
| `FACTURAS_PDF_DIR` | `<data>/<env>/pdf` | Dónde se guardan los PDF |

Con el valor por defecto, `FACTURAS_PROVIDER=mock`, todo funciona sin conexión:

- `crear_borrador` y `listar_facturas` funcionan con normalidad.
- `emitir_factura` asigna números reales de la serie en la carpeta local del sandbox.
- `descargar_pdf` genera un PDF marcado como "MOCK, SIN VALIDEZ FISCAL".

## Añadirlo a Claude Code

Ejecuta esto desde la raíz del repositorio:

```sh
claude mcp add facturas --scope user -- node "$PWD/dist/index.js"
```

Guarda las claves en `~/.config/facturas-mcp/.env`. Evita `-e BEEL_API_KEY=…`, porque `claude mcp add -e` guarda el valor en el propio fichero de configuración de Claude Code.

Compruébalo con `claude mcp list`, o con `/mcp` dentro de Claude Code. Al arrancar, el servidor escribe su entorno en stderr, por ejemplo `entorno=sandbox · proveedor=mock`.

Ejemplo de petición: *"Crea un borrador para Cliente SL (B12345674, Calle X 1, 28001 Madrid): servicio de consultoría 1.700 €, material revendido 727,19 €. Ya ha pagado 500 €."* Claude te mostrará el resumen y solo emitirá la factura cuando se lo indiques.

## Sandbox de BeeL: qué tienes que hacer

Durante el desarrollo no se creó ninguna cuenta. Para pasar del mock al sandbox de BeeL (gratuito, sin tarjeta, y que solo envía al **entorno de pruebas de la AEAT**):

1. **Regístrate.** Entra en <https://app.beel.es/signup> y da de alta tu empresa (tu NIF y tu dirección) en el panel.
2. **Crea una clave de sandbox.** En Settings → API Keys, crea una clave con el prefijo `beel_sk_test_` y los permisos (scopes) `invoices:read` e `invoices:write`. Añade `series:write` si quieres crear la serie por API.
3. **Obtén el UUID de tu empresa.** Está en el panel, o puedes consultarlo con:
   ```sh
   curl -s https://app.beel.es/api/v1/me/identity -H "Authorization: Bearer $BEEL_API_KEY"
   ```
4. **Crea la serie en el sandbox** para que la numeración de BeeL coincida con la tuya: tipo de documento STANDARD, formato `{YYYY}{NUM:3}`, `counter_reset` ANNUAL y marcada como serie por defecto. `initial_number` tiene que ser el siguiente número de tu serie, es decir, los tres últimos dígitos de `FACTURAS_NUMERO_INICIAL` sin ceros a la izquierda: `1` si la serie empieza de cero este año (2026001), o `2` si ya emitiste la 2026001 con otro programa (2026002). Puedes hacerlo en el panel o con `POST /v1/companies/{company_id}/series`. Dos observaciones:
   - BeeL bloquea el formato en cuanto la serie ha emitido una factura. Comprueba que la primera factura del sandbox sale con el número que espera el servidor (el de `FACTURAS_NUMERO_INICIAL`).
   - Si BeeL asigna un número distinto, el servidor registra el número de BeeL y muestra un aviso.
5. **Configura el servidor.** Pon `FACTURAS_PROVIDER=beel`, `BEEL_API_KEY` y `BEEL_COMPANY_ID` en `~/.config/facturas-mcp/.env` y reinicia Claude Code.
6. **Prueba en el sandbox.** Crea un borrador, emítelo con confirmación, descarga el PDF y revisa el QR y los importes.

**Pasar a producción más adelante** (no está hecho, y no debe hacerse sin haberlo decidido antes):

1. Activa el plan API de BeeL para tu NIF (~15 €/mes en el plan anual, 19 €/mes en el mensual, más IVA).
2. Crea una clave `beel_sk_live_` y la misma serie en el entorno real.
3. Configura `FACTURAS_ENV=production`.

## Limitaciones

- **Lo ya pagado** solo aparece en el PDF como nota ("Importe ya abonado… Importe pendiente…"). BeeL no tiene un campo de pago parcial, así que el "total a pagar" del propio BeeL sigue mostrando el total completo.
- **La fecha de emisión** es siempre el día en que emites (la fija BeeL). Usa `fecha_operacion` para un servicio prestado un día anterior.
- **Fuera del alcance:** IVA exento (0 %), facturas simplificadas, facturas rectificativas y anulaciones. Para eso, usa el panel de BeeL o su propio MCP (`claude mcp add --transport http beel https://mcp.beel.es/mcp`).
- **Contraste de importes:** nuestros importes redondean el IVA una vez por tipo y se comparan con los totales de BeeL en cada emisión. Si hay una diferencia, se muestra como aviso, y el documento legal es el PDF de BeeL.
- **Sin probar contra la API real:** el adaptador de BeeL sigue el OpenAPI 1.9.0 de BeeL y está cubierto por tests con un `fetch` simulado. Todavía no se ha ejecutado contra el sandbox real, porque aún no existe ninguna clave.

## Desarrollo

```sh
npm test            # vitest: importes, controles, numeración, mapeo a BeeL, extremo a extremo por MCP
npm run typecheck   # src + tests
npm run build       # dist/
```

Estructura del código:

- `src/invoice.ts`: importes y validación
- `src/numbering.ts`: reglas de la serie
- `src/issue.ts`: controles y orquestación de la emisión
- `src/providers/`: interfaz de los adaptadores, `beel.ts`, `mock.ts`
- `src/server.ts`: herramientas MCP
