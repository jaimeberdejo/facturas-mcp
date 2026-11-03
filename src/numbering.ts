import { ConfigError, RefusedError } from './errors.js';

/**
 * Invoice numbers follow Jaime's series: 4-digit year + 3-digit sequence (2026001, 2026002…).
 * A new year restarts at YYYY001. Numbers only move forward; an issued number is never reused.
 */
const NUMBER_PATTERN = /^(\d{4})(\d{3})$/;

export interface IssuedNumber {
  numero: string;
  borradorId: string;
  fecha: string;
}

export interface SeriesState {
  /** Every number already issued in this environment. */
  emitidas: IssuedNumber[];
  /**
   * A number handed to the provider whose outcome is unknown (network error, 5xx).
   * Only the same draft may use it; it is settled by retrying that draft.
   */
  pendiente?: { borradorId: string; numero: string; desde: string };
}

export function parseInvoiceNumber(numero: string): { year: number; seq: number } {
  const match = NUMBER_PATTERN.exec(numero);
  if (!match) {
    throw new ConfigError(`Número de factura "${numero}" no sigue el formato AAAANNN (p. ej. 2026003)`);
  }
  return { year: Number(match[1]), seq: Number(match[2]) };
}

function format(year: number, seq: number): string {
  if (seq < 1 || seq > 999) {
    throw new ConfigError(`La serie ${year} se ha agotado (máximo ${year}999)`);
  }
  return `${year}${String(seq).padStart(3, '0')}`;
}

function compare(a: string, b: string): number {
  return Number(a) - Number(b);
}

/**
 * Next number for an invoice issued on `issueDate` (YYYY-MM-DD).
 *
 * It is the highest of: the configured start (e.g. 2026003) and the last issued number + 1.
 * If that number belongs to a past year, the series restarts at {year}001.
 */
export function nextInvoiceNumber(state: SeriesState, start: string, issueDate: string): string {
  const year = Number(issueDate.slice(0, 4));
  const configured = parseInvoiceNumber(start);

  let candidate = format(configured.year, configured.seq);
  const last = [...state.emitidas].map((e) => e.numero).sort(compare).at(-1);
  if (last) {
    const parsed = parseInvoiceNumber(last);
    const afterLast = format(parsed.year, parsed.seq + 1);
    if (compare(afterLast, candidate) > 0) candidate = afterLast;
  }

  const candidateYear = parseInvoiceNumber(candidate).year;
  if (candidateYear > year) {
    throw new ConfigError(
      `El siguiente número (${candidate}) es de un año posterior a la fecha de emisión (${issueDate}). ` +
        'Revisa FACTURAS_NUMERO_INICIAL.',
    );
  }
  if (candidateYear < year) {
    candidate = format(year, 1);
  }

  assertNotUsed(state, candidate);
  return candidate;
}

export function assertNotUsed(state: SeriesState, numero: string): void {
  if (state.emitidas.some((e) => e.numero === numero)) {
    throw new RefusedError(`El número ${numero} ya se usó. Un número de factura nunca se reutiliza.`);
  }
}
