import { existsSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/errors.js';
import { createServer } from '../src/server.js';
import { REFERENCE_INPUT } from './fixtures.js';
import { harness, type Harness } from './helpers.js';

let h: Harness;
afterEach(() => h?.cleanup());

async function connect(h: Harness, getProvider = () => h.provider) {
  const server = createServer({ config: h.config, store: h.store, getProvider, today: h.today, now: h.now });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
    return { isError: result.isError === true, text };
  };
  return { client, call };
}

function draftId(text: string): string {
  const match = /Borrador (bor_[0-9a-f]{8})/.exec(text);
  if (!match) throw new Error(`no draft id in:\n${text}`);
  return match[1]!;
}

describe('MCP server (mock provider)', () => {
  it('exposes the four tools', async () => {
    h = harness();
    const { client } = await connect(h);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['crear_borrador', 'descargar_pdf', 'emitir_factura', 'listar_facturas']);
    expect(tools.find((t) => t.name === 'emitir_factura')?.annotations?.destructiveHint).toBe(true);
  });

  it('runs the whole flow: draft → refused without confirm → issue → list → PDF', async () => {
    h = harness();
    const { call } = await connect(h);

    const created = await call('crear_borrador', { ...REFERENCE_INPUT });
    expect(created.isError).toBe(false);
    expect(created.text).toContain('[MOCK');
    expect(created.text).toContain('Base imponible:        2.876,45 €');
    expect(created.text).toContain('IRPF 7 % s/ 1.960,00 € (solo servicios): −137,20 €');
    expect(created.text).toContain('TOTAL FACTURA:         3.343,30 €');
    expect(created.text).toContain('PENDIENTE DE PAGO:     2.234,40 €');
    const id = draftId(created.text);

    const refused = await call('emitir_factura', { borrador_id: id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^RECHAZADO: .*confirm: true/);

    const prod = await call('emitir_factura', { borrador_id: id, confirm: true, entorno: 'production' });
    expect(prod.isError).toBe(true);
    expect(prod.text).toContain('FACTURAS_ENV=production');
    expect(h.provider.calls).toHaveLength(0);

    const issued = await call('emitir_factura', { borrador_id: id, confirm: true });
    expect(issued.isError).toBe(false);
    expect(issued.text).toContain('Factura 2026001');

    const listed = await call('listar_facturas');
    expect(listed.text).toContain(`| 2026001 | 2026-11-03 | Cliente de Prueba SL | 3.343,30 € | emitida | ${id} |`);

    const pdf = await call('descargar_pdf', { numero: '2026001' });
    expect(pdf.isError).toBe(false);
    const path = /PDF guardado en (\S+\.pdf)/.exec(pdf.text)![1]!;
    expect(path).toMatch(/Factura-2026001-MOCK\.pdf$/);
    expect(path.startsWith(h.config.dataDir)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'latin1').startsWith('%PDF-1.4')).toBe(true);
  });

  it('returns validation errors as tool errors, without storing anything', async () => {
    h = harness();
    const { call } = await connect(h);
    const result = await call('crear_borrador', { ...REFERENCE_INPUT, ya_pagado: 999999 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^DATOS NO VÁLIDOS: ya_pagado/);
    expect(h.store.listDrafts()).toHaveLength(0);
  });

  it('refuses to download the PDF of a draft', async () => {
    h = harness();
    const { call } = await connect(h);
    const id = draftId((await call('crear_borrador', { ...REFERENCE_INPUT })).text);
    const result = await call('descargar_pdf', { borrador_id: id });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('emítelo antes');
  });

  it('keeps drafts and listing working when the provider is not configured', async () => {
    h = harness();
    const { call } = await connect(h, () => {
      throw new ConfigError('Falta BEEL_API_KEY');
    });
    const id = draftId((await call('crear_borrador', { ...REFERENCE_INPUT })).text);
    const issued = await call('emitir_factura', { borrador_id: id, confirm: true });
    expect(issued.isError).toBe(true);
    expect(issued.text).toBe('CONFIGURACIÓN: Falta BEEL_API_KEY');
    expect((await call('listar_facturas', { estado: 'borrador' })).text).toContain(id);
  });

  it('warns in the listing when an issue is unresolved', async () => {
    h = harness();
    const { call } = await connect(h);
    const id = draftId((await call('crear_borrador', { ...REFERENCE_INPUT })).text);
    h.provider.failNext = 'unknown';
    const issued = await call('emitir_factura', { borrador_id: id, confirm: true });
    expect(issued.text).toMatch(/^ERROR DEL PROVEEDOR: .*\n.*queda reservado/);
    expect((await call('listar_facturas')).text).toContain(`Emisión sin confirmar: borrador ${id}, número 2026001`);
  });
});
