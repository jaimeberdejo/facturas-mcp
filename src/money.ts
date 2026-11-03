import { ValidationError } from './errors.js';

/**
 * Money is handled as integer cents. Decimal inputs are parsed from their string form into
 * BigInt so that 727.19 is exactly 72719 cents, never 72718.99999.
 */
export type Cents = number;

/** Parse a decimal number into an integer scaled by 10^decimals, rejecting extra precision. */
export function toScaled(value: number, decimals: number, field: string): bigint {
  if (!Number.isFinite(value)) {
    throw new ValidationError(`${field}: debe ser un número`);
  }
  const text = String(value);
  if (/e/i.test(text)) {
    throw new ValidationError(`${field}: valor fuera de rango (${text})`);
  }
  const negative = text.startsWith('-');
  const [intPart = '0', fracPart = ''] = (negative ? text.slice(1) : text).split('.');
  if (fracPart.length > decimals) {
    throw new ValidationError(`${field}: admite como máximo ${decimals} decimales (${text})`);
  }
  const scaled = BigInt(intPart + fracPart.padEnd(decimals, '0'));
  return negative ? -scaled : scaled;
}

/** Integer division rounding half away from zero (the usual commercial rounding). */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const absRemainder = remainder < 0n ? -remainder : remainder;
  if (absRemainder * 2n >= denominator) {
    return numerator < 0n ? quotient - 1n : quotient + 1n;
  }
  return quotient;
}

export function eurosToCents(value: number, field: string): Cents {
  return Number(toScaled(value, 2, field));
}

/** Percentage (up to 2 decimals, e.g. 21, 7, 5.2) applied to an amount in cents. */
export function percentOf(amount: Cents, percent: number, field: string): Cents {
  const hundredths = toScaled(percent, 2, field); // 21 -> 2100
  return Number(roundDiv(BigInt(amount) * hundredths, 10_000n));
}

/** Base of a line: quantity (≤3 decimals) × unit price (≤4 decimals), rounded to cents. */
export function lineBase(quantity: number, unitPrice: number, field: string): Cents {
  const q = toScaled(quantity, 3, `${field}.cantidad`);
  const p = toScaled(unitPrice, 4, `${field}.precio_unitario`);
  return Number(roundDiv(q * p, 100_000n));
}

const formatter = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: 'always',
});

/** 287645 -> "2.876,45 €" */
export function formatEuros(cents: Cents): string {
  return `${formatter.format(cents / 100)} €`;
}

/** 287645 -> 2876.45 (for APIs that take decimal numbers). */
export function centsToNumber(cents: Cents): number {
  return cents / 100;
}
