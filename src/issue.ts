import type { Config } from './config.js';
import { ConfigError, ProviderError, RefusedError, ValidationError } from './errors.js';
import type { Draft, Environment, Issue } from './invoice.js';
import { formatEuros } from './money.js';
import { assertNotUsed, nextInvoiceNumber } from './numbering.js';
import type { InvoiceProvider, IssueResult } from './providers/types.js';
import type { LocalStore } from './store.js';

export interface IssueArgs {
  borrador_id: string;
  confirm?: unknown;
  entorno?: Environment;
}

/**
 * Safety rules for issuing. Issuing a real invoice is irreversible, so:
 * 1. `confirm` must be exactly `true` (the user said yes to this specific draft).
 * 2. Production needs FACTURAS_ENV=production in the server config. A tool argument alone never
 *    reaches production.
 * 3. When the server IS in production, the call must also say `entorno: "production"`, so a
 *    caller that thinks it is testing cannot issue a real invoice by accident.
 */
export function assertIssueAllowed(args: Pick<IssueArgs, 'confirm' | 'entorno'>, configuredEnv: Environment): void {
  if (args.confirm !== true) {
    throw new RefusedError(
      'Emisión rechazada: falta confirm: true. Muestra el resumen del borrador al usuario y emite solo si lo confirma expresamente.',
    );
  }
  const requested = args.entorno ?? 'sandbox';
  if (requested === 'production' && configuredEnv !== 'production') {
    throw new RefusedError(
      'Emisión rechazada: se pidió producción, pero el servidor no está en producción. ' +
        'Producción solo se activa con FACTURAS_ENV=production en la configuración del servidor.',
    );
  }
  if (configuredEnv === 'production' && requested !== 'production') {
    throw new RefusedError(
      'Emisión rechazada: el servidor está en PRODUCCIÓN y esta factura sería real. ' +
        'Si el usuario lo ha confirmado, repite la llamada con entorno: "production".',
    );
  }
}

export interface IssueServiceDeps {
  config: Config;
  store: LocalStore;
  getProvider: () => InvoiceProvider;
  today: () => string;
  now: () => Date;
}

export class IssueService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: IssueServiceDeps) {}

  /** Issues one draft at a time: two concurrent calls can never take the same number. */
  issue(args: IssueArgs): Promise<Draft & { emision: Issue }> {
    const run = this.queue.then(() => this.issueNow(args));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async issueNow(args: IssueArgs): Promise<Draft & { emision: Issue }> {
    const { config, store } = this.deps;
    assertIssueAllowed(args, config.env);

    const provider = this.deps.getProvider();
    if (provider.environment !== config.env) {
      throw new ConfigError(`El proveedor está en ${provider.environment} pero el servidor en ${config.env}.`);
    }

    const draft = store.getDraft(args.borrador_id);
    if (!draft) throw new ValidationError(`No existe el borrador ${args.borrador_id} en ${config.env}.`);
    if (draft.estado === 'emitida' && draft.emision) {
      throw new RefusedError(`El borrador ${draft.id} ya se emitió como factura ${draft.emision.numero}.`);
    }

    const series = store.loadSeries();
    let numero: string;
    const retry = series.pendiente !== undefined;
    if (series.pendiente) {
      if (series.pendiente.borradorId !== draft.id) {
        throw new RefusedError(
          `La emisión del borrador ${series.pendiente.borradorId} (número ${series.pendiente.numero}) quedó sin confirmar. ` +
            'Vuelve a emitir ese borrador primero para saber si se registró; hasta entonces no se emite ninguna otra.',
        );
      }
      numero = series.pendiente.numero; // retrying the same draft keeps its reserved number
    } else {
      numero = nextInvoiceNumber(series, config.numeroInicial, this.deps.today());
      series.pendiente = { borradorId: draft.id, numero, desde: this.deps.now().toISOString() };
      store.saveSeries(series);
    }

    let result: IssueResult;
    try {
      result = await provider.issueInvoice({ draft, expectedNumber: numero, issuer: config.issuer, retry });
    } catch (error) {
      if (error instanceof ProviderError && error.outcome === 'rejected') {
        // Nothing was registered: release the reservation so the series stays correlative.
        const current = store.loadSeries();
        delete current.pendiente;
        store.saveSeries(current);
      } else if (error instanceof ProviderError) {
        throw new ProviderError(
          `${error.message}\nResultado desconocido: el número ${numero} queda reservado para el borrador ${draft.id}. ` +
            'Vuelve a llamar a emitir_factura con ese mismo borrador para comprobarlo. No crees un borrador nuevo.',
          error.outcome,
          error.details,
        );
      }
      throw error;
    }

    const avisos: string[] = [];
    if (result.number !== numero) {
      avisos.push(
        `El proveedor asignó el número ${result.number} en lugar de ${numero}. Revisa la serie configurada en el proveedor.`,
      );
    }
    if (result.totals) {
      const ours = draft.totales;
      const checks: [string, number, number][] = [
        ['base', ours.base, result.totals.base],
        ['IVA', ours.iva, result.totals.iva],
        ['IRPF', ours.irpf, result.totals.irpf],
        ['total', ours.total, result.totals.total],
      ];
      for (const [label, local, remote] of checks) {
        if (local !== remote) {
          avisos.push(`Diferencia en ${label}: local ${formatEuros(local)}, proveedor ${formatEuros(remote)}.`);
        }
      }
    }

    const final = store.loadSeries();
    try {
      assertNotUsed(final, result.number);
    } catch {
      avisos.push(`El número ${result.number} ya constaba como emitido localmente. Revisa la serie.`);
    }
    final.emitidas.push({ numero: result.number, borradorId: draft.id, fecha: result.issueDate });
    delete final.pendiente;
    store.saveSeries(final);

    const emision: Issue = {
      numero: result.number,
      fecha: result.issueDate,
      proveedor: provider.name,
      proveedorId: result.providerId,
      entorno: config.env,
      ...(result.verifactuStatus ? { estadoVerifactu: result.verifactuStatus } : {}),
      avisos,
    };
    const issued: Draft & { emision: Issue } = { ...draft, estado: 'emitida', emision };
    store.saveDraft(issued);
    return issued;
  }
}
