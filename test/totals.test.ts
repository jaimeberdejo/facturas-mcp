import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/errors.js';
import { buildDraftContent, type DraftInput } from '../src/invoice.js';
import { CLIENT, REFERENCE_INPUT } from './fixtures.js';
import { formatEuros, lineBase, percentOf } from '../src/money.js';
import { isValidNif } from '../src/nif.js';

describe('invoice amounts', () => {
  it('matches the reference case: base 2,876.45 · IVA 604.05 · IRPF 137.20 · total 3,343.30 · due 2,234.40', () => {
    const { totales } = buildDraftContent(REFERENCE_INPUT, 7);
    expect(totales.base).toBe(287645);
    expect(totales.iva).toBe(60405);
    expect(totales.irpfBase).toBe(196000);
    expect(totales.irpf).toBe(13720);
    expect(totales.total).toBe(334330);
    expect(totales.yaPagado).toBe(110890);
    expect(totales.pendiente).toBe(223440);
  });

  it('applies IRPF to service lines only', () => {
    const { lineas } = buildDraftContent(REFERENCE_INPUT, 7);
    expect(lineas.map((l) => l.irpf)).toEqual([7, 7, 0, 0]);
  });

  it('uses the configured default IRPF when the draft does not set one', () => {
    const { irpf, totales } = buildDraftContent({ ...REFERENCE_INPUT, irpf: undefined }, 15);
    expect(irpf).toBe(15);
    expect(totales.irpf).toBe(29400); // 15 % of 1,960.00
  });

  it('formats euros the Spanish way', () => {
    expect(formatEuros(334330)).toBe('3.343,30 €');
    expect(formatEuros(13720)).toBe('137,20 €');
  });

  it('works in exact cents (no float drift)', () => {
    expect(lineBase(3, 0.1, 'x')).toBe(30);
    expect(lineBase(1, 727.19, 'x')).toBe(72719);
    expect(lineBase(2.5, 33.3333, 'x')).toBe(8333); // 83.33325 -> 83.33
    expect(percentOf(287645, 21, 'iva')).toBe(60405); // 604.0545 -> 604.05
    expect(percentOf(250, 21, 'iva')).toBe(53); // 0.525 -> 0.53 (half up)
  });

  it('groups IVA by rate', () => {
    const { totales } = buildDraftContent(
      {
        cliente: CLIENT,
        lineas: [
          { descripcion: 'Servicio', precio_unitario: 100, tipo: 'servicio' },
          { descripcion: 'Libro', precio_unitario: 50, tipo: 'bien', iva: 4 },
        ],
      },
      7,
    );
    expect(totales.ivaDesglose).toEqual([
      { tipo: 21, base: 10000, cuota: 2100 },
      { tipo: 4, base: 5000, cuota: 200 },
    ]);
    expect(totales.total).toBe(10000 + 5000 + 2100 + 200 - 700);
  });
});

describe('draft validation', () => {
  const bad = (patch: Partial<DraftInput>) => () => buildDraftContent({ ...REFERENCE_INPUT, ...patch }, 7);

  it('rejects an already-paid amount above the total', () => {
    expect(bad({ ya_pagado: 4000 })).toThrow(ValidationError);
  });

  it('rejects an invoice without lines', () => {
    expect(bad({ lineas: [] })).toThrow(/al menos una línea/);
  });

  it('rejects an invalid NIF', () => {
    expect(bad({ cliente: { ...CLIENT, nif: 'B12345675' } })).toThrow(/NIF/);
  });

  it('rejects an IRPF rate the AEAT does not accept', () => {
    expect(bad({ irpf: 8 })).toThrow(/irpf/);
  });

  it('rejects more than 2 decimals in already paid', () => {
    expect(bad({ ya_pagado: 1.005 })).toThrow(/decimales/);
  });

  it('rejects an impossible operation date', () => {
    expect(bad({ fecha_operacion: '2026-02-30' })).toThrow(/fecha_operacion/);
  });
});

describe('NIF check', () => {
  // Synthetic IDs with valid control characters (B12345674 is the example from BeeL's docs).
  it.each(['12345678Z', 'X1234567L', 'B12345674', 'A76543214', 'Q7654321D'])('accepts %s', (nif) => {
    expect(isValidNif(nif)).toBe(true);
  });
  it.each(['12345678A', 'B12345670', 'ABC', ''])('rejects %s', (nif) => {
    expect(isValidNif(nif)).toBe(false);
  });
});
