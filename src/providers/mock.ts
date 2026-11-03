import { ProviderError } from '../errors.js';
import type { Draft, Issue } from '../invoice.js';
import { formatEuros } from '../money.js';
import { renderTextPdf } from '../pdf.js';
import type { InvoiceProvider, IssueRequest, IssueResult, PdfFile } from './types.js';

/**
 * In-process fake provider. Registers nothing anywhere. Used by the tests and as the
 * default provider until a BeeL sandbox key exists.
 */
export class MockProvider implements InvoiceProvider {
  readonly name = 'mock';
  readonly environment = 'sandbox' as const;

  /** Every issue request received, for assertions in tests. */
  readonly calls: IssueRequest[] = [];
  /** Make the next issue call fail like a provider would. */
  failNext?: 'rejected' | 'unknown';
  /** Make the provider assign a different number than expected (to test the mismatch warning). */
  overrideNumber?: string;

  constructor(private readonly today: () => string) {}

  async issueInvoice(request: IssueRequest): Promise<IssueResult> {
    this.calls.push(request);
    const failure = this.failNext;
    this.failNext = undefined;
    if (failure === 'rejected') {
      throw new ProviderError('Mock: el proveedor rechazó la factura (simulado)', 'rejected', {
        status: 422,
        code: 'MOCK_VALIDATION_ERROR',
      });
    }
    if (failure === 'unknown') {
      throw new ProviderError('Mock: sin respuesta del proveedor (simulado)', 'unknown');
    }
    const number = this.overrideNumber ?? request.expectedNumber;
    const t = request.draft.totales;
    return {
      providerId: `mock-${number}`,
      number,
      issueDate: this.today(),
      totals: { base: t.base, iva: t.iva, irpf: t.irpf, total: t.total },
      verifactuStatus: 'MOCK (no enviada a la AEAT)',
    };
  }

  async downloadPdf(draft: Draft & { emision: Issue }): Promise<PdfFile> {
    const t = draft.totales;
    const lines = [
      `FACTURA ${draft.emision.numero}  -  MOCK, SIN VALIDEZ FISCAL`,
      `Fecha: ${draft.emision.fecha}`,
      '',
      `Cliente: ${draft.cliente.nombre} (${draft.cliente.nif})`,
      '',
      ...draft.lineas.map(
        (l) => `${l.cantidad} x ${l.descripcion} [${l.tipo}]  ${formatEuros(l.base)}  IVA ${l.iva}%`,
      ),
      '',
      `Base imponible: ${formatEuros(t.base)}`,
      `IVA: ${formatEuros(t.iva)}`,
      `IRPF ${t.irpfTipo}%: -${formatEuros(t.irpf)}`,
      `Total factura: ${formatEuros(t.total)}`,
      ...(t.yaPagado > 0
        ? [`Ya abonado: ${formatEuros(t.yaPagado)}`, `Pendiente: ${formatEuros(t.pendiente)}`]
        : []),
      '',
      'Documento generado por el proveedor mock de facturas-mcp. No enviado a la AEAT.',
    ];
    return { data: renderTextPdf(lines), fileName: `MOCK-${draft.emision.numero}.pdf` };
  }
}
