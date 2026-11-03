import { describe, expect, it } from 'vitest';
import { BEEL_DEFAULT_BASE_URL } from '../src/config.js';
import { ConfigError, ProviderError } from '../src/errors.js';
import { buildDraftContent, type Draft, type Issue } from '../src/invoice.js';
import { BeelProvider } from '../src/providers/beel.js';
import { REFERENCE_INPUT } from './fixtures.js';

// Fake credentials: the right shape, not real keys. No test here talks to the network.
const TEST_KEY = 'beel_sk_test_fake_key_for_unit_tests';
const LIVE_KEY = 'beel_sk_live_fake_key_for_unit_tests';
const COMPANY = '11111111-2222-4333-8444-555555555555';
const BASE = BEEL_DEFAULT_BASE_URL;

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Scripted fetch: each call shifts the next response off the queue and records the request. */
function fakeFetch(responses: (Response | Error)[]) {
  const calls: Recorded[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const draft: Draft = {
  id: 'bor_0a1b2c3d',
  estado: 'borrador',
  entorno: 'sandbox',
  creado: '2026-11-03T10:00:00.000Z',
  ...buildDraftContent(REFERENCE_INPUT, 7),
};

const issuedInvoice = {
  id: '99999999-aaaa-4bbb-8ccc-dddddddddddd',
  status: 'ISSUED',
  invoice_number: '2026003',
  issue_date: '2026-11-03',
  totals: { taxable_base: 2876.45, total_vat: 604.05, total_irpf: 137.2, invoice_total: 3343.3, total_to_pay: 3343.3 },
  verifactu: { status: 'PENDING' },
};

function provider(fetchFn: typeof fetch, env: 'sandbox' | 'production' = 'sandbox', apiKey = TEST_KEY) {
  return new BeelProvider({ apiKey, companyId: COMPANY, baseUrl: BASE }, env, fetchFn, async () => {});
}

describe('BeeL adapter: environment safety', () => {
  it('refuses a live key in sandbox (it would hit production)', () => {
    expect(() => provider(fetch, 'sandbox', LIVE_KEY)).toThrow(ConfigError);
  });

  it('refuses a test key in production', () => {
    expect(() => provider(fetch, 'production', TEST_KEY)).toThrow(/beel_sk_live_/);
  });

  it('explains how to get a key when there is none', () => {
    expect(
      () => new BeelProvider({ companyId: COMPANY, baseUrl: BASE }, 'sandbox'),
    ).toThrow(/beel_sk_test_/);
  });

  it('requires the company UUID', () => {
    expect(() => new BeelProvider({ apiKey: TEST_KEY, baseUrl: BASE }, 'sandbox')).toThrow(/BEEL_COMPANY_ID/);
  });
});

describe('BeeL adapter: request mapping', () => {
  it('sends IRPF 7 on services and an explicit 0 on goods', () => {
    const body = provider(fetch).buildCreateBody({ draft, expectedNumber: '2026003', issuer: {} }) as {
      lines: { irpf_rate: number; main_tax: unknown; unit_price: number }[];
    };
    expect(body.lines.map((l) => l.irpf_rate)).toEqual([7, 7, 0, 0]);
    expect(body.lines[2]).toMatchObject({ unit_price: 727.19, main_tax: { type: 'IVA', percentage: 21, regime_key: '01' } });
  });

  it('puts already-paid and due amounts in the notes, and the draft id as external_ref', () => {
    const body = provider(fetch).buildCreateBody({
      draft,
      expectedNumber: '2026003',
      issuer: { iban: 'ES0000000000000000000000' },
    });
    expect(body.notes).toBe('Importe ya abonado: 1.108,90 €. Importe pendiente de pago: 2.234,40 €.');
    expect(body.external_ref).toBe(draft.id);
    expect(body.type).toBe('STANDARD');
    expect(body.payment_info).toEqual({ method: 'BANK_TRANSFER', iban: 'ES0000000000000000000000' });
    expect(body.options).toEqual({ issue_directly: true, wait_for_pdf: true, send_automatically: false });
  });
});

describe('BeeL adapter: issuing', () => {
  it('looks up the external_ref, then creates and issues in one call', async () => {
    const f = fakeFetch([json(200, { success: true, data: { invoices: [] } }), json(201, { success: true, data: issuedInvoice })]);
    const result = await provider(f.fn).issueInvoice({ draft, expectedNumber: '2026003', issuer: {} });

    expect(result).toEqual({
      providerId: issuedInvoice.id,
      number: '2026003',
      issueDate: '2026-11-03',
      totals: { base: 287645, iva: 60405, irpf: 13720, total: 334330 },
      verifactuStatus: 'PENDING',
    });
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/companies/${COMPANY}/invoices?external_ref=${draft.id}&fiscal_only=false&limit=5`);
    expect(f.calls[1]!.method).toBe('POST');
    expect(f.calls[1]!.url).toBe(`${BASE}/v1/companies/${COMPANY}/invoices`);
    expect(f.calls[1]!.headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(f.calls[1]!.headers['Idempotency-Key']).toMatch(/^facturas-mcp-bor_0a1b2c3d-/);
  });

  it('recovers an invoice an earlier attempt already issued, without creating another', async () => {
    const f = fakeFetch([json(200, { success: true, data: { invoices: [issuedInvoice] } })]);
    const result = await provider(f.fn).issueInvoice({ draft, expectedNumber: '2026003', issuer: {} });
    expect(result.number).toBe('2026003');
    expect(f.calls).toHaveLength(1);
  });

  it('issues a BeeL draft left behind by an earlier attempt', async () => {
    const leftover = { ...issuedInvoice, status: 'DRAFT', invoice_number: null };
    const f = fakeFetch([
      json(200, { success: true, data: { invoices: [leftover] } }),
      json(200, { success: true, data: issuedInvoice }),
    ]);
    await provider(f.fn).issueInvoice({ draft, expectedNumber: '2026003', issuer: {} });
    expect(f.calls[1]!.url).toBe(`${BASE}/v1/companies/${COMPANY}/invoices/${issuedInvoice.id}/issue?wait_for_pdf=true`);
  });

  it('treats a 422 as rejected (nothing registered)', async () => {
    const f = fakeFetch([
      json(200, { success: true, data: { invoices: [] } }),
      json(422, { success: false, error: { code: 'VALIDATION_ERROR', message: 'bad nif' } }),
    ]);
    const error = await provider(f.fn).issueInvoice({ draft, expectedNumber: '2026003', issuer: {} }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.outcome).toBe('rejected');
    expect(error.details).toEqual({ status: 422, code: 'VALIDATION_ERROR' });
  });

  it('treats a 5xx or a network error as unknown', async () => {
    for (const failure of [json(503, { success: false }), new TypeError('fetch failed')]) {
      const f = fakeFetch([json(200, { success: true, data: { invoices: [] } }), failure]);
      const error = await provider(f.fn).issueInvoice({ draft, expectedNumber: '2026003', issuer: {} }).catch((e) => e);
      expect(error.outcome).toBe('unknown');
    }
  });

  it('treats a failed lookup as unknown (cannot rule out an earlier registration)', async () => {
    const f = fakeFetch([json(401, { success: false, error: { code: 'UNAUTHORIZED', message: 'no' } })]);
    const error = await provider(f.fn).issueInvoice({ draft, expectedNumber: '2026003', issuer: {} }).catch((e) => e);
    expect(error.outcome).toBe('unknown');
  });

  it('resolves a duplicate external_ref by returning the existing invoice', async () => {
    const f = fakeFetch([
      json(200, { success: true, data: { invoices: [] } }),
      json(409, { success: false, error: { code: 'INVOICE_DUPLICATE_EXTERNAL_REFERENCE', message: 'dup' } }),
      json(200, { success: true, data: { invoices: [issuedInvoice] } }),
    ]);
    const result = await provider(f.fn).issueInvoice({ draft, expectedNumber: '2026003', issuer: {} });
    expect(result.providerId).toBe(issuedInvoice.id);
  });
});

describe('BeeL adapter: PDF', () => {
  const issued = {
    ...draft,
    estado: 'emitida',
    emision: { numero: '2026003', fecha: '2026-11-03', proveedor: 'beel', proveedorId: issuedInvoice.id, entorno: 'sandbox', avisos: [] },
  } as Draft & { emision: Issue };
  const pdfBytes = new TextEncoder().encode('%PDF-1.4 fake');

  it('follows the pre-signed URL without sending the API key to it', async () => {
    const f = fakeFetch([
      new Response(null, { status: 202, headers: { 'Retry-After': '1' } }),
      json(200, { success: true, data: { download_url: 'https://storage.example/f.pdf', expires_in_seconds: 300, file_name: 'F-2026003.pdf' } }),
      new Response(pdfBytes, { status: 200 }),
    ]);
    const pdf = await provider(f.fn).downloadPdf(issued);
    expect(new TextDecoder().decode(pdf.data)).toBe('%PDF-1.4 fake');
    expect(f.calls[0]!.url).toBe(`${BASE}/v1/companies/${COMPANY}/invoices/${issuedInvoice.id}/pdf`);
    expect(f.calls[2]!.url).toBe('https://storage.example/f.pdf');
    expect(f.calls[2]!.headers.Authorization).toBeUndefined();
  });

  it('rejects a download that is not a PDF', async () => {
    const f = fakeFetch([
      json(200, { success: true, data: { download_url: 'https://storage.example/f.pdf', expires_in_seconds: 300, file_name: 'x' } }),
      new Response('<html>', { status: 200 }),
    ]);
    await expect(provider(f.fn).downloadPdf(issued)).rejects.toThrow(/no es un PDF/);
  });
});
