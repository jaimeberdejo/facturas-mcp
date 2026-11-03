# facturas-mcp

MCP server (stdio) for drafting and issuing Spanish invoices under VERI*FACTU through a third-party provider that is already a compliant SIF ([BeeL](https://beel.es)).

This server does **not** implement a SIF itself: no hash chain, no SOAP to the AEAT, no declaración responsable. BeeL does all of that. This server adds:

- local drafts
- exact amounts
- IRPF on services only
- the "already paid" amount
- a confirmation guard
- sandbox by default
- a series that never reuses a number

The provider comparison and the reasons for BeeL are in [RESEARCH.md](RESEARCH.md).

## Tools

| Tool | What it does | Calls the provider? |
|---|---|---|
| `crear_borrador` | Validates the client and lines, then computes base, IVA, IRPF (service lines only), total, already paid and amount due. Saves a local draft and returns a readable summary. | No |
| `emitir_factura` | Issues a draft with the next number of the series. Requires `confirm: true`. Uses the sandbox unless the server has `FACTURAS_ENV=production`. | Yes |
| `descargar_pdf` | Downloads the PDF (with the VERI*FACTU QR) of an issued invoice to the local PDF folder. | Yes |
| `listar_facturas` | Lists drafts and issued invoices: number, date, client, total, status. | No |

Line types:

- `servicio`: a professional service. Carries IRPF, 7 % by default.
- `bien`: goods re-invoiced at cost. Never carries IRPF.

Both carry IVA at 21 % unless the line says otherwise (10 % and 4 % are also accepted).

## Safety rules

1. **Nothing is issued without `confirm: true`.** It must be the boolean `true`; "yes" or `1` are refused. The tool description tells Claude to set it only after you explicitly confirm that specific draft.
2. **Sandbox by default.** Production needs `FACTURAS_ENV=production` in the server's configuration. A tool argument alone can never reach production.
3. **Production needs a second confirmation.** When the server is in production, each `emitir_factura` call must also say `entorno: "production"`. A caller that thinks it is testing therefore cannot issue a real invoice.
4. **Keys are tied to the environment.** In sandbox, the BeeL adapter refuses any key that does not start with `beel_sk_test_`. In production it requires `beel_sk_live_`. BeeL uses one URL for both environments and the key decides, so this check is what keeps sandbox off production.
5. **The mock cannot run as production.** `FACTURAS_ENV=production` with `FACTURAS_PROVIDER=mock` stops the server at startup.
6. **Numbers are never reused.** Issues run one at a time. The number is reserved before calling the provider, and what happens to it depends on the provider's answer:
   - **Rejected** (validation or auth error, nothing registered): the number is released, so the series stays correlative.
   - **Unknown** (timeout, 5xx): the number stays reserved for that same draft, and no other draft can be issued until you retry it. The retry looks the invoice up by its draft id (`external_ref` in BeeL), so it can never create a duplicate.
7. **Sandbox and production never share numbers.** Each environment has its own data folder.
8. **No secrets in the repo.** Issuer data and keys live in `~/.config/facturas-mcp/.env`, outside the repo. Only `.env.example` with placeholders is committed. `data/` and `.env` are gitignored.

## Setup

Requires Node.js 22 or newer.

```sh
npm install
npm run build
npm test
```

Configuration: copy the example outside the repo and fill it in.

```sh
mkdir -p ~/.config/facturas-mcp
cp .env.example ~/.config/facturas-mcp/.env
chmod 600 ~/.config/facturas-mcp/.env
```

The server reads, highest priority first:

1. real environment variables;
2. the file at `FACTURAS_CONFIG_FILE` (default `~/.config/facturas-mcp/.env`);
3. a `.env` in the repo root (gitignored).

| Variable | Default | Meaning |
|---|---|---|
| `FACTURAS_ENV` | `sandbox` | `sandbox` or `production`. Anything else stops the server. |
| `FACTURAS_PROVIDER` | `mock` | `mock` (nothing leaves your machine) or `beel` |
| `FACTURAS_NUMERO_INICIAL` | `2026003` | First number to issue, format `YYYYNNN`. Raising it moves the series forward; it never goes back. A new year restarts at `YYYY001`. |
| `FACTURAS_IRPF_POR_DEFECTO` | `7` | IRPF % on service lines |
| `FACTURAS_EMISOR_*` | none | Issuer name, NIF, address, IBAN and email. The IBAN goes on the invoice as the bank-transfer payment method. |
| `BEEL_API_KEY` | none | `beel_sk_test_…` for the sandbox |
| `BEEL_COMPANY_ID` | none | UUID of your company in BeeL |
| `BEEL_SERIES_ID` | company default | UUID of the STANDARD series |
| `FACTURAS_DATA_DIR` | `<repo>/data` | Drafts and series state, one subfolder per environment |
| `FACTURAS_PDF_DIR` | `<data>/<env>/pdf` | Where PDFs are saved |

With the default `FACTURAS_PROVIDER=mock`, everything works offline:

- `crear_borrador` and `listar_facturas` behave normally.
- `emitir_factura` assigns real series numbers in the local sandbox folder.
- `descargar_pdf` writes a PDF marked "MOCK, SIN VALIDEZ FISCAL".

## Add it to Claude Code

Run this from the repo root:

```sh
claude mcp add facturas --scope user -- node "$PWD/dist/index.js"
```

Keep keys in `~/.config/facturas-mcp/.env`. Avoid `-e BEEL_API_KEY=…`, because `claude mcp add -e` stores the value in Claude Code's own config file.

Check it with `claude mcp list`, or `/mcp` inside Claude Code. The server logs its environment to stderr on startup, for example `entorno=sandbox · proveedor=mock`.

Example prompt: *"Crea un borrador para Cliente SL (B12345674, Calle X 1, 28001 Madrid): servicio de consultoría 1.700 €, material revendido 727,19 €. Ya ha pagado 500 €."* Claude will show the summary. It issues the invoice only after you say so.

## BeeL sandbox: what you need to do

No account was created while building this. To move from the mock to the BeeL sandbox (free, no card, sends to the **AEAT test environment** only):

1. **Sign up.** Go to <https://app.beel.es/signup> and set up your company (your NIF and address) in the dashboard.
2. **Create a sandbox key.** In Settings → API Keys, create a key with prefix `beel_sk_test_` and scopes `invoices:read` and `invoices:write`. Add `series:write` if you want to create the series by API.
3. **Get your company UUID.** Find it in the dashboard or with:
   ```sh
   curl -s https://app.beel.es/api/v1/me/identity -H "Authorization: Bearer $BEEL_API_KEY"
   ```
4. **Create the series in the sandbox** so BeeL's numbers match yours: document type STANDARD, format `{YYYY}{NUM:3}`, `counter_reset` ANNUAL, `initial_number` 3, default series. Do this in the dashboard or via `POST /v1/companies/{company_id}/series`. Two notes:
   - BeeL locks the format once the series has issued an invoice. Check that the first sandbox invoice comes out as `2026003`.
   - If BeeL assigns a different number, the server records BeeL's number and shows a warning.
5. **Configure the server.** Put `FACTURAS_PROVIDER=beel`, `BEEL_API_KEY` and `BEEL_COMPANY_ID` in `~/.config/facturas-mcp/.env`, then restart Claude Code.
6. **Test in the sandbox.** Create a draft, issue it with confirmation, download the PDF, and check the QR and amounts.

**Moving to production later** (not done, and not to be done without a decision):

1. Activate the BeeL API plan for your NIF (~15 €/month annual, 19 €/month monthly, plus IVA).
2. Create a `beel_sk_live_` key and the same series in the live environment.
3. Set `FACTURAS_ENV=production`.

## Limitations

- **Already paid** is shown on the PDF only as a note ("Importe ya abonado… Importe pendiente…"). BeeL has no partial-payment field, so BeeL's own "total a pagar" still shows the full total.
- **Issue date** is always the day you issue (BeeL sets it). Use `fecha_operacion` for a service delivered on an earlier day.
- **Out of scope:** exempt (0 %) IVA, simplified invoices, corrective invoices and voids. Use BeeL's dashboard or its own MCP (`claude mcp add --transport http beel https://mcp.beel.es/mcp`) for those.
- **Amount cross-check:** our amounts round IVA once per rate, and are compared with BeeL's totals on every issue. A difference is reported as a warning, and BeeL's PDF is the legal document.
- **Untested against the live API:** the BeeL adapter follows BeeL's OpenAPI 1.9.0 and is covered by tests with a scripted `fetch`. It has not yet run against the real sandbox, because no key exists yet.

## Development

```sh
npm test            # vitest: amounts, guard, numbering, BeeL mapping, end-to-end over MCP
npm run typecheck   # src + tests
npm run build       # dist/
```

Code layout:

- `src/invoice.ts`: amounts and validation
- `src/numbering.ts`: series rules
- `src/issue.ts`: issue guard and orchestration
- `src/providers/`: adapter interface, `beel.ts`, `mock.ts`
- `src/server.ts`: MCP tools
