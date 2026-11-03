import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, todayInSpain } from '../src/config.js';
import { ConfigError, ProviderError, RefusedError } from '../src/errors.js';
import { assertIssueAllowed, IssueService } from '../src/issue.js';
import { nextInvoiceNumber } from '../src/numbering.js';
import type { InvoiceProvider } from '../src/providers/types.js';
import { harness, type Harness } from './helpers.js';
import { REFERENCE_INPUT } from './fixtures.js';

let h: Harness;
afterEach(() => h?.cleanup());

function service(h: Harness, provider: InvoiceProvider = h.provider): IssueService {
  return new IssueService({ config: h.config, store: h.store, getProvider: () => provider, today: h.today, now: h.now });
}

describe('issue guard', () => {
  it('refuses without confirm, and never calls the provider', async () => {
    h = harness();
    const draft = h.addDraft(REFERENCE_INPUT);
    await expect(service(h).issue({ borrador_id: draft.id })).rejects.toThrow(RefusedError);
    await expect(service(h).issue({ borrador_id: draft.id, confirm: false })).rejects.toThrow(/confirm: true/);
    expect(h.provider.calls).toHaveLength(0);
    expect(h.store.getDraft(draft.id)?.estado).toBe('borrador');
    expect(h.store.loadSeries()).toEqual({ emitidas: [] });
  });

  it('accepts only the boolean true, not truthy values', () => {
    for (const confirm of ['true', 'yes', 1, {}]) {
      expect(() => assertIssueAllowed({ confirm }, 'sandbox')).toThrow(RefusedError);
    }
    expect(() => assertIssueAllowed({ confirm: true }, 'sandbox')).not.toThrow();
  });

  it('refuses production when FACTURAS_ENV is not production', async () => {
    h = harness();
    const draft = h.addDraft(REFERENCE_INPUT);
    await expect(
      service(h).issue({ borrador_id: draft.id, confirm: true, entorno: 'production' }),
    ).rejects.toThrow(/FACTURAS_ENV=production/);
    expect(h.provider.calls).toHaveLength(0);
  });

  it('defaults to sandbox when FACTURAS_ENV is unset', () => {
    expect(loadConfig({}).env).toBe('sandbox');
    expect(loadConfig({ FACTURAS_ENV: '' }).env).toBe('sandbox');
  });

  it('rejects unknown FACTURAS_ENV values instead of guessing', () => {
    expect(() => loadConfig({ FACTURAS_ENV: 'prod' })).toThrow(ConfigError);
    expect(() => loadConfig({ FACTURAS_ENV: 'PRODUCTION' })).toThrow(ConfigError);
  });

  it('in production, also requires the call to say entorno: "production"', () => {
    expect(() => assertIssueAllowed({ confirm: true }, 'production')).toThrow(/PRODUCCIÓN/);
    expect(() => assertIssueAllowed({ confirm: true, entorno: 'sandbox' }, 'production')).toThrow(RefusedError);
    expect(() => assertIssueAllowed({ confirm: true, entorno: 'production' }, 'production')).not.toThrow();
  });

  it('refuses to run production with the mock provider', () => {
    expect(() => loadConfig({ FACTURAS_ENV: 'production' })).toThrow(/mock/);
  });
});

describe('issuing and numbering', () => {
  it('issues the first invoice as 2026001 and the next as 2026002', async () => {
    h = harness();
    const a = h.addDraft(REFERENCE_INPUT);
    const b = h.addDraft(REFERENCE_INPUT);
    const first = await service(h).issue({ borrador_id: a.id, confirm: true });
    const second = await service(h).issue({ borrador_id: b.id, confirm: true });
    expect(first.emision.numero).toBe('2026001');
    expect(second.emision.numero).toBe('2026002');
    expect(first.emision.avisos).toEqual([]);
    expect(h.store.getDraft(a.id)?.estado).toBe('emitida');
    expect(h.store.loadSeries().emitidas.map((e) => e.numero)).toEqual(['2026001', '2026002']);
  });

  it('uses the configured start number to continue an existing series', async () => {
    h = harness({ FACTURAS_NUMERO_INICIAL: '2026002' });
    const a = h.addDraft(REFERENCE_INPUT);
    expect((await service(h).issue({ borrador_id: a.id, confirm: true })).emision.numero).toBe('2026002');
  });

  it('refuses to issue the same draft twice', async () => {
    h = harness();
    const a = h.addDraft(REFERENCE_INPUT);
    await service(h).issue({ borrador_id: a.id, confirm: true });
    await expect(service(h).issue({ borrador_id: a.id, confirm: true })).rejects.toThrow(/ya se emitió/);
    expect(h.provider.calls).toHaveLength(1);
  });

  it('serializes concurrent calls: two drafts never share a number', async () => {
    h = harness();
    const s = service(h);
    const drafts = [h.addDraft(REFERENCE_INPUT), h.addDraft(REFERENCE_INPUT), h.addDraft(REFERENCE_INPUT)];
    const issued = await Promise.all(drafts.map((d) => s.issue({ borrador_id: d.id, confirm: true })));
    expect(issued.map((i) => i.emision.numero).sort()).toEqual(['2026001', '2026002', '2026003']);
  });

  it('releases the number when the provider rejects (nothing registered)', async () => {
    h = harness();
    const a = h.addDraft(REFERENCE_INPUT);
    h.provider.failNext = 'rejected';
    await expect(service(h).issue({ borrador_id: a.id, confirm: true })).rejects.toThrow(ProviderError);
    expect(h.store.loadSeries()).toEqual({ emitidas: [] });
    const retry = await service(h).issue({ borrador_id: a.id, confirm: true });
    expect(retry.emision.numero).toBe('2026001');
  });

  it('keeps the number reserved for the same draft when the outcome is unknown', async () => {
    h = harness();
    const a = h.addDraft(REFERENCE_INPUT);
    const b = h.addDraft(REFERENCE_INPUT);
    h.provider.failNext = 'unknown';
    await expect(service(h).issue({ borrador_id: a.id, confirm: true })).rejects.toThrow(/queda reservado/);
    expect(h.store.loadSeries().pendiente).toMatchObject({ borradorId: a.id, numero: '2026001' });

    // Another draft cannot jump the queue while 2026001 is unresolved.
    await expect(service(h).issue({ borrador_id: b.id, confirm: true })).rejects.toThrow(/quedó sin confirmar/);

    // Retrying the same draft settles it with the same number.
    const settled = await service(h).issue({ borrador_id: a.id, confirm: true });
    expect(settled.emision.numero).toBe('2026001');
    expect(h.provider.calls.map((c) => [c.expectedNumber, c.retry])).toEqual([
      ['2026001', false],
      ['2026001', true],
    ]);
    expect((await service(h).issue({ borrador_id: b.id, confirm: true })).emision.numero).toBe('2026002');
  });

  it('records the provider number and warns when it differs from ours', async () => {
    h = harness();
    const a = h.addDraft(REFERENCE_INPUT);
    h.provider.overrideNumber = '2026007';
    const issued = await service(h).issue({ borrador_id: a.id, confirm: true });
    expect(issued.emision.numero).toBe('2026007');
    expect(issued.emision.avisos[0]).toMatch(/2026007 en lugar de 2026001/);
    h.provider.overrideNumber = undefined;
    const next = await service(h).issue({ borrador_id: h.addDraft(REFERENCE_INPUT).id, confirm: true });
    expect(next.emision.numero).toBe('2026008'); // never goes back to 2026001
  });

  it('does not issue when the provider is not configured', async () => {
    h = harness();
    const a = h.addDraft(REFERENCE_INPUT);
    const s = new IssueService({
      config: h.config,
      store: h.store,
      getProvider: () => {
        throw new ConfigError('Falta BEEL_API_KEY');
      },
      today: h.today,
      now: h.now,
    });
    await expect(s.issue({ borrador_id: a.id, confirm: true })).rejects.toThrow(/BEEL_API_KEY/);
    expect(h.store.loadSeries()).toEqual({ emitidas: [] });
  });
});

describe('series rules', () => {
  const state = (...numbers: string[]) => ({
    emitidas: numbers.map((numero) => ({ numero, borradorId: 'bor_00000000', fecha: '2026-11-03' })),
  });

  it('continues after the highest issued number', () => {
    expect(nextInvoiceNumber(state('2026003', '2026004'), '2026003', '2026-12-01')).toBe('2026005');
  });

  it('restarts at YYYY001 in a new year', () => {
    expect(nextInvoiceNumber(state('2026009'), '2026003', '2027-01-02')).toBe('2027001');
  });

  it('lets the configured start move the series forward, never backward', () => {
    expect(nextInvoiceNumber(state('2026004'), '2026020', '2026-12-01')).toBe('2026020');
    expect(nextInvoiceNumber(state('2026004'), '2026001', '2026-12-01')).toBe('2026005');
  });

  it('rejects a start number from a future year', () => {
    expect(() => nextInvoiceNumber(state(), '2027001', '2026-12-01')).toThrow(ConfigError);
  });

  it('defaults the start number to the first of the current year (Spanish time)', () => {
    expect(loadConfig({}, '2026-11-03').numeroInicial).toBe('2026001');
    expect(loadConfig({}, '2027-03-15').numeroInicial).toBe('2027001');
    expect(loadConfig({ FACTURAS_NUMERO_INICIAL: '2026002' }, '2026-11-03').numeroInicial).toBe('2026002');
    // 31 Dec 23:30 UTC is already 1 Jan in Madrid.
    expect(todayInSpain(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01');
  });

  it('rejects a start number that is not YYYYNNN', () => {
    expect(() => loadConfig({ FACTURAS_NUMERO_INICIAL: 'F-3' })).toThrow(ConfigError);
  });
});
