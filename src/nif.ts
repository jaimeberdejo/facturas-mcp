/**
 * Spanish tax ID (NIF) check: DNI, NIE and CIF (legal entities), including the control
 * character. Catching a typo here is cheaper than a rejected registration at AEAT.
 */

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
const CIF_CONTROL_LETTERS = 'JABCDEFGHI';

export function normalizeNif(raw: string): string {
  return raw.toUpperCase().replace(/[\s.-]/g, '');
}

export function isValidNif(raw: string): boolean {
  const nif = normalizeNif(raw);
  if (/^\d{8}[A-Z]$/.test(nif)) {
    return DNI_LETTERS[Number(nif.slice(0, 8)) % 23] === nif[8];
  }
  if (/^[XYZ]\d{7}[A-Z]$/.test(nif)) {
    const prefix = String('XYZ'.indexOf(nif[0]!));
    return DNI_LETTERS[Number(prefix + nif.slice(1, 8)) % 23] === nif[8];
  }
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(nif)) {
    return isValidCif(nif);
  }
  // K, L, M: special NIFs for individuals without DNI. Same letter algorithm as DNI.
  if (/^[KLM]\d{7}[A-Z]$/.test(nif)) {
    return DNI_LETTERS[Number(nif.slice(1, 8)) % 23] === nif[8];
  }
  return false;
}

function isValidCif(nif: string): boolean {
  const digits = nif.slice(1, 8);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[i]);
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  const controlDigit = (10 - (sum % 10)) % 10;
  const control = nif[8]!;
  const letter = nif[0]!;
  // Entities that must use a letter / a digit; the rest accept either.
  if ('KPQS'.includes(letter) || nif.startsWith('N') || nif.startsWith('W')) {
    return control === CIF_CONTROL_LETTERS[controlDigit];
  }
  if ('ABEH'.includes(letter)) {
    return control === String(controlDigit);
  }
  return control === String(controlDigit) || control === CIF_CONTROL_LETTERS[controlDigit];
}
