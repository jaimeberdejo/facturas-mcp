import { randomUUID } from 'node:crypto';
import type { BeelConfig } from '../config.js';
import { ConfigError, ProviderError } from '../errors.js';
import type { Draft, Environment, Issue } from '../invoice.js';
import { formatEuros } from '../money.js';
import type { InvoiceProvider, IssueRequest, IssueResult, PdfFile } from './types.js';

/**
 * BeeL adapter (https://docs.beel.es, OpenAPI 1.9.0).
 *
 * BeeL uses ONE base URL for both environments; the API key prefix selects the environment:
 * `beel_sk_test_` = sandbox (AEAT test environment), `beel_sk_live_` = production.
 * So the safety rule lives here: in sandbox we refuse any key that is not a test key.
 */

type FetchFn = typeof fetch;

interface BeelInvoice {
  id: string;
  status: string;
  invoice_number?: string | null;
  issue_date?: string;
  totals?: {
    taxable_base?: number;
    total_vat?: number;
    total_irpf?: number;
    invoice_total?: number;
  };
  verifactu?: { status?: string } | null;
}

interface BeelErrorBody {
  error?: { code?: string; message?: string };
  detail?: string;
}

const KEY_PREFIX: Record<Environment, string> = {
  sandbox: 'beel_sk_test_',
  production: 'beel_sk_live_',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class BeelProvider implements InvoiceProvider {
  readonly name = 'beel';
  private readonly apiKey: string;
  private readonly companyPath: string;

  constructor(
    private readonly config: BeelConfig,
    readonly environment: Environment,
    private readonly fetchFn: FetchFn = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!config.apiKey) {
      throw new ConfigError(
        'Falta BEEL_API_KEY. Crea una clave de sandbox (beel_sk_test_…) en app.beel.es → Settings → API Keys.',
      );
    }
    const prefix = KEY_PREFIX[environment];
    if (!config.apiKey.startsWith(prefix)) {
      throw new ConfigError(
        environment === 'sandbox'
          ? 'BEEL_API_KEY no es una clave de sandbox (beel_sk_test_…). Se rechaza para no tocar producción.'
          : 'FACTURAS_ENV=production exige una clave de producción (beel_sk_live_…).',
      );
    }
    if (!config.companyId || !UUID.test(config.companyId)) {
      throw new ConfigError('Falta BEEL_COMPANY_ID (UUID de tu empresa en BeeL, no el NIF).');
    }
    if (config.seriesId && !UUID.test(config.seriesId)) {
      throw new ConfigError('BEEL_SERIES_ID debe ser un UUID.');
    }
    this.apiKey = config.apiKey;
    this.companyPath = `/v1/companies/${config.companyId}`;
  }

  /** Request body for POST /v1/companies/{id}/invoices. Exposed for tests. */
  buildCreateBody(request: IssueRequest): Record<string, unknown> {
    const { draft, issuer } = request;
    const c = draft.cliente;
    return {
      type: 'STANDARD',
      ...(this.config.seriesId ? { series_id: this.config.seriesId } : {}),
      ...(draft.fecha_operacion ? { operation_date: draft.fecha_operacion } : {}),
      recipient: {
        legal_name: c.nombre,
        nif: c.nif,
        ...(c.email ? { email: c.email } : {}),
        address: {
          street: c.direccion.calle,
          ...(c.direccion.numero ? { number: c.direccion.numero } : {}),
          postal_code: c.direccion.cp,
          city: c.direccion.ciudad,
          province: c.direccion.provincia,
          country: c.direccion.pais ?? 'España',
        },
      },
      lines: draft.lineas.map((line) => ({
        description: line.descripcion,
        quantity: line.cantidad,
        unit_price: line.precio_unitario,
        main_tax: { type: 'IVA', percentage: line.iva, regime_key: '01' },
        // Always explicit: an omitted irpf_rate inherits the company default in BeeL.
        irpf_rate: line.irpf,
      })),
      ...(issuer.iban ? { payment_info: { method: 'BANK_TRANSFER', iban: issuer.iban } } : {}),
      ...(buildNotes(draft) ? { notes: buildNotes(draft) } : {}),
      external_ref: draft.id,
      options: { issue_directly: true, wait_for_pdf: true, send_automatically: false },
    };
  }

  async issueInvoice(request: IssueRequest): Promise<IssueResult> {
    // An earlier attempt may have created it (timeout after BeeL accepted). Look first.
    const existing = await this.findByExternalRef(request.draft.id);
    if (existing) return this.finishExisting(existing);

    try {
      const created = await this.call<BeelInvoice>('POST', `${this.companyPath}/invoices`, {
        body: this.buildCreateBody(request),
        idempotencyKey: `facturas-mcp-${request.draft.id}-${randomUUID()}`,
      });
      return toResult(created);
    } catch (error) {
      if (error instanceof ProviderError && error.details.code === 'INVOICE_DUPLICATE_EXTERNAL_REFERENCE') {
        const again = await this.findByExternalRef(request.draft.id);
        if (again) return this.finishExisting(again);
        throw new ProviderError(error.message, 'unknown', error.details);
      }
      throw error;
    }
  }

  async downloadPdf(draft: Draft & { emision: Issue }): Promise<PdfFile> {
    const path = `${this.companyPath}/invoices/${draft.emision.proveedorId}/pdf`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.raw('GET', path, { headers: { Prefer: 'wait=10' } });
      if (response.status === 202) {
        const retryAfter = Number(response.headers.get('Retry-After') ?? '2');
        await this.sleep(Math.min(Math.max(retryAfter, 1), 10) * 1000);
        continue;
      }
      const data = await this.unwrap<{ download_url: string; file_name?: string }>(response);
      const file = await this.fetchFn(data.download_url);
      if (!file.ok) {
        throw new ProviderError(`No se pudo descargar el PDF (HTTP ${file.status})`, 'rejected', {
          status: file.status,
        });
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') {
        throw new ProviderError('La descarga no es un PDF', 'rejected');
      }
      return { data: bytes, ...(data.file_name ? { fileName: data.file_name } : {}) };
    }
    throw new ProviderError('BeeL sigue generando el PDF. Vuelve a intentarlo en un minuto.', 'rejected');
  }

  private async findByExternalRef(ref: string): Promise<BeelInvoice | undefined> {
    const query = new URLSearchParams({ external_ref: ref, fiscal_only: 'false', limit: '5' });
    let data: { invoices?: BeelInvoice[] };
    try {
      data = await this.call('GET', `${this.companyPath}/invoices?${query}`);
    } catch (error) {
      // We cannot tell whether an earlier attempt registered it: keep the number reserved.
      if (error instanceof ProviderError) {
        throw new ProviderError(`No se pudo comprobar si la factura ya existe: ${error.message}`, 'unknown', error.details);
      }
      throw error;
    }
    return data.invoices?.[0];
  }

  private async finishExisting(invoice: BeelInvoice): Promise<IssueResult> {
    if (invoice.status === 'DRAFT') {
      const issued = await this.call<BeelInvoice>(
        'POST',
        `${this.companyPath}/invoices/${invoice.id}/issue?wait_for_pdf=true`,
        { idempotencyKey: `facturas-mcp-issue-${invoice.id}` },
      );
      return toResult(issued);
    }
    return toResult(invoice);
  }

  private async raw(
    method: string,
    path: string,
    options: { body?: unknown; idempotencyKey?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      ...options.headers,
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    try {
      return await this.fetchFn(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ProviderError(`Sin respuesta de BeeL: ${(error as Error).message}`, 'unknown');
    }
  }

  private async call<T>(
    method: string,
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    return this.unwrap<T>(await this.raw(method, path, options));
  }

  private async unwrap<T>(response: Response): Promise<T> {
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (response.ok) {
      return (json as { data: T }).data;
    }
    const body = (json ?? {}) as BeelErrorBody;
    const code = body.error?.code;
    const message = body.error?.message ?? body.detail ?? `HTTP ${response.status}`;
    // 4xx: BeeL refused the request, nothing was registered. 409 can be a duplicate or a
    // request still in flight, and 5xx can hide a success, so those stay "unknown".
    const outcome =
      response.status >= 400 && response.status < 500 && response.status !== 409 ? 'rejected' : 'unknown';
    throw new ProviderError(`BeeL ${response.status}${code ? ` ${code}` : ''}: ${message}`, outcome, {
      status: response.status,
      ...(code ? { code } : {}),
    });
  }
}

/** Already-paid and due amounts go in the notes: BeeL has no partial-payment field. */
export function buildNotes(draft: Draft): string | undefined {
  const parts: string[] = [];
  if (draft.notas) parts.push(draft.notas);
  const t = draft.totales;
  if (t.yaPagado > 0) {
    parts.push(`Importe ya abonado: ${formatEuros(t.yaPagado)}. Importe pendiente de pago: ${formatEuros(t.pendiente)}.`);
  }
  return parts.length ? parts.join('\n') : undefined;
}

function toCents(value: number | undefined): number | undefined {
  return typeof value === 'number' ? Math.round(value * 100) : undefined;
}

function toResult(invoice: BeelInvoice): IssueResult {
  if (!invoice.invoice_number) {
    throw new ProviderError(`BeeL devolvió la factura ${invoice.id} sin número (estado ${invoice.status})`, 'unknown');
  }
  const t = invoice.totals;
  const base = toCents(t?.taxable_base);
  const iva = toCents(t?.total_vat);
  const irpf = toCents(t?.total_irpf);
  const total = toCents(t?.invoice_total);
  return {
    providerId: invoice.id,
    number: invoice.invoice_number,
    issueDate: invoice.issue_date ?? new Date().toISOString().slice(0, 10),
    ...(base !== undefined && iva !== undefined && irpf !== undefined && total !== undefined
      ? { totals: { base, iva, irpf, total } }
      : {}),
    ...(invoice.verifactu?.status ? { verifactuStatus: invoice.verifactu.status } : {}),
  };
}
