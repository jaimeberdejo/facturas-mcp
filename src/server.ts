import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { ConfigError, ProviderError, RefusedError, ValidationError } from './errors.js';
import { buildDraftContent, type Draft, type DraftInput, type Issue } from './invoice.js';
import { IssueService } from './issue.js';
import type { InvoiceProvider } from './providers/types.js';
import type { LocalStore } from './store.js';
import { envLabel, formatDraftSummary, formatList } from './summary.js';

export interface ServerDeps {
  config: Config;
  store: LocalStore;
  getProvider: () => InvoiceProvider;
  today: () => string;
  now: () => Date;
}

const INSTRUCTIONS = `Facturas españolas (VERI*FACTU) a través de un proveedor que ya es SIF (BeeL).
Reglas:
- Crea siempre un borrador con crear_borrador y enseña el resumen al usuario.
- Llama a emitir_factura con confirm: true SOLO si el usuario confirma expresamente ese borrador. Emitir es irreversible.
- El servidor trabaja en sandbox salvo que su configuración diga FACTURAS_ENV=production.`;

const addressSchema = z.object({
  calle: z.string().describe('Calle o vía, p. ej. "Calle Mayor"'),
  numero: z.string().optional().describe('Número, piso, puerta'),
  cp: z.string().describe('Código postal (5 dígitos en España)'),
  ciudad: z.string(),
  provincia: z.string(),
  pais: z.string().optional().describe('Por defecto España'),
});

const draftShape = {
  cliente: z.object({
    nombre: z.string().describe('Razón social del cliente'),
    nif: z.string().describe('NIF/CIF del cliente'),
    direccion: addressSchema,
    email: z.string().optional(),
  }),
  lineas: z
    .array(
      z.object({
        descripcion: z.string(),
        cantidad: z.number().optional().describe('Por defecto 1'),
        precio_unitario: z.number().describe('Precio sin IVA, en euros'),
        tipo: z
          .enum(['servicio', 'bien'])
          .describe('"servicio" = servicio profesional (lleva IRPF). "bien" = bien revendido a coste (sin IRPF).'),
        iva: z.number().optional().describe('Tipo de IVA en %, por defecto 21'),
      }),
    )
    .min(1),
  irpf: z.number().optional().describe('Retención IRPF en % sobre las líneas de servicio (por defecto la configurada, 7)'),
  ya_pagado: z.number().optional().describe('Importe que el cliente ya ha pagado, en euros'),
  fecha_operacion: z.string().optional().describe('AAAA-MM-DD si el servicio se prestó otro día distinto al de emisión'),
  notas: z.string().optional().describe('Texto libre que aparecerá en la factura'),
};

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function fail(error: unknown): CallToolResult {
  const prefix =
    error instanceof RefusedError
      ? 'RECHAZADO'
      : error instanceof ValidationError
        ? 'DATOS NO VÁLIDOS'
        : error instanceof ConfigError
          ? 'CONFIGURACIÓN'
          : error instanceof ProviderError
            ? 'ERROR DEL PROVEEDOR'
            : 'ERROR';
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: `${prefix}: ${message}` }] };
}

async function guarded(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    return fail(error);
  }
}

export function createServer(deps: ServerDeps): McpServer {
  const { config, store } = deps;
  const issuer = new IssueService(deps);
  const server = new McpServer({ name: 'facturas-mcp', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'crear_borrador',
    {
      title: 'Crear borrador de factura',
      description:
        'Valida y guarda un borrador local. Calcula base, IVA, IRPF (solo líneas de servicio), total, ya pagado y pendiente. ' +
        'No llama a ningún proveedor ni registra nada.',
      inputSchema: draftShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      guarded(() => {
        const content = buildDraftContent(args as DraftInput, config.irpfPorDefecto);
        const draft: Draft = {
          id: store.newDraftId(),
          estado: 'borrador',
          entorno: config.env,
          creado: deps.now().toISOString(),
          ...content,
        };
        store.saveDraft(draft);
        return ok(
          `${formatDraftSummary(draft, config)}\n\n` +
            `Siguiente paso: revisa el resumen. Para emitir, llama a emitir_factura con borrador_id "${draft.id}" ` +
            'y confirm: true, solo tras la confirmación expresa del usuario.',
        );
      }),
  );

  server.registerTool(
    'emitir_factura',
    {
      title: 'Emitir factura (irreversible)',
      description:
        'Emite un borrador a través del proveedor VERI*FACTU y le asigna el siguiente número de la serie. IRREVERSIBLE. ' +
        'Exige confirm: true, que solo debes poner si el usuario ha confirmado expresamente este borrador. ' +
        'Usa el sandbox salvo que el servidor esté configurado con FACTURAS_ENV=production; en ese caso exige además entorno: "production".',
      inputSchema: {
        borrador_id: z.string().describe('Id del borrador (bor_xxxxxxxx)'),
        confirm: z.boolean().optional().describe('true solo si el usuario ha confirmado la emisión de este borrador'),
        entorno: z
          .enum(['sandbox', 'production'])
          .optional()
          .describe('Por defecto sandbox. "production" solo funciona si el servidor tiene FACTURAS_ENV=production.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      guarded(async () => {
        const issued = await issuer.issue(args);
        return ok(
          `Factura emitida.\n\n${formatDraftSummary(issued, config)}\n\n` +
            `Siguiente paso: descargar_pdf con numero "${issued.emision.numero}".`,
        );
      }),
  );

  server.registerTool(
    'descargar_pdf',
    {
      title: 'Descargar PDF de una factura emitida',
      description: 'Descarga del proveedor el PDF (con el QR VERI*FACTU) de una factura emitida y lo guarda en la carpeta local de PDFs.',
      inputSchema: {
        numero: z.string().optional().describe('Número de factura, p. ej. 2026003'),
        borrador_id: z.string().optional().describe('Alternativa al número: id del borrador emitido'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (args) =>
      guarded(async () => {
        if (!args.numero && !args.borrador_id) {
          throw new ValidationError('Indica numero o borrador_id');
        }
        const draft = args.numero ? store.findByNumber(args.numero) : store.getDraft(args.borrador_id!);
        if (!draft) throw new ValidationError(`No encuentro la factura ${args.numero ?? args.borrador_id} en ${config.env}`);
        if (!draft.emision) throw new ValidationError(`${draft.id} es un borrador: emítelo antes de descargar el PDF`);
        const issued = draft as Draft & { emision: Issue };

        const pdf = await deps.getProvider().downloadPdf(issued);
        const tag = issued.emision.proveedor === 'mock' ? '-MOCK' : issued.emision.entorno === 'sandbox' ? '-SANDBOX' : '';
        mkdirSync(config.pdfDir, { recursive: true, mode: 0o700 });
        const path = join(config.pdfDir, `Factura-${issued.emision.numero}${tag}.pdf`);
        writeFileSync(path, pdf.data, { mode: 0o600 });
        store.saveDraft({ ...issued, emision: { ...issued.emision, pdf: path } });
        return ok(`${envLabel(config.env, config.provider)}\nPDF guardado en ${path} (${pdf.data.length} bytes).`);
      }),
  );

  server.registerTool(
    'listar_facturas',
    {
      title: 'Listar borradores y facturas',
      description: 'Lista los borradores y las facturas emitidas en el entorno actual: número, fecha, cliente, total y estado.',
      inputSchema: {
        estado: z.enum(['todas', 'borrador', 'emitida']).optional().describe('Filtro, por defecto todas'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guarded(() => {
        const filter = args.estado ?? 'todas';
        const drafts = store.listDrafts().filter((d) => filter === 'todas' || d.estado === filter);
        const pending = store.loadSeries().pendiente;
        const warning = pending
          ? `\n\n⚠ Emisión sin confirmar: borrador ${pending.borradorId}, número ${pending.numero}. Vuelve a emitir ese borrador.`
          : '';
        return ok(formatList(drafts, config) + warning);
      }),
  );

  return server;
}
