import { ValidationError } from './errors.js';
import { type Cents, eurosToCents, lineBase, percentOf } from './money.js';
import { isValidNif, normalizeNif } from './nif.js';

export type Environment = 'sandbox' | 'production';

/** `servicio` lines bear IRPF withholding; `bien` (goods re-invoiced at cost) never do. */
export type LineKind = 'servicio' | 'bien';

/** IVA rates accepted. 0 % (exempt) needs an exemption reason and is out of scope for now. */
export const IVA_RATES = [21, 10, 4] as const;

/** IRPF rates the AEAT accepts on an invoice (same list BeeL validates). */
export const IRPF_RATES = [0, 1, 2, 2.8, 6, 7, 7.6, 9.5, 15, 19, 24] as const;

export interface AddressInput {
  calle: string;
  numero?: string;
  cp: string;
  ciudad: string;
  provincia: string;
  pais?: string;
}

export interface ClientInput {
  nombre: string;
  nif: string;
  direccion: AddressInput;
  email?: string;
}

export interface LineInput {
  descripcion: string;
  cantidad?: number;
  precio_unitario: number;
  tipo: LineKind;
  iva?: number;
}

export interface DraftInput {
  cliente: ClientInput;
  lineas: LineInput[];
  /** IRPF % applied to service lines only. Defaults to the configured rate (7 %). */
  irpf?: number;
  /** Amount already paid by the client, in euros. */
  ya_pagado?: number;
  /** YYYY-MM-DD, when the service was delivered on a different day than the issue. */
  fecha_operacion?: string;
  notas?: string;
}

export interface Line {
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  tipo: LineKind;
  iva: number;
  irpf: number;
  base: Cents;
}

export interface Totals {
  base: Cents;
  iva: Cents;
  ivaDesglose: { tipo: number; base: Cents; cuota: Cents }[];
  irpfTipo: number;
  irpfBase: Cents;
  irpf: Cents;
  total: Cents;
  yaPagado: Cents;
  pendiente: Cents;
}

export interface Client {
  nombre: string;
  nif: string;
  direccion: AddressInput;
  email?: string;
}

export interface Issue {
  numero: string;
  fecha: string;
  proveedor: string;
  proveedorId: string;
  entorno: Environment;
  estadoVerifactu?: string;
  avisos: string[];
  pdf?: string;
}

export interface Draft {
  id: string;
  estado: 'borrador' | 'emitida';
  entorno: Environment;
  creado: string;
  cliente: Client;
  lineas: Line[];
  irpf: number;
  fecha_operacion?: string;
  notas?: string;
  totales: Totals;
  emision?: Issue;
}

/** Validated draft content, before it gets an id and timestamps. */
export type DraftContent = Pick<
  Draft,
  'cliente' | 'lineas' | 'irpf' | 'fecha_operacion' | 'notas' | 'totales'
>;

function requireText(value: string | undefined, field: string, max = 255): string {
  const text = (value ?? '').trim();
  if (!text) throw new ValidationError(`${field}: obligatorio`);
  if (text.length > max) throw new ValidationError(`${field}: máximo ${max} caracteres`);
  return text;
}

function isRealDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

/**
 * Computes the invoice amounts.
 *
 * - Line base = quantity × unit price, rounded to cents.
 * - IVA = rate × sum of line bases at that rate, rounded once per rate.
 * - IRPF = rate × sum of the bases of service lines (goods never bear IRPF).
 * - Total = base + IVA − IRPF. Due = total − already paid.
 */
export function computeTotals(lines: Line[], irpfRate: number, alreadyPaid: Cents): Totals {
  const base = lines.reduce((sum, line) => sum + line.base, 0);

  const byRate = new Map<number, Cents>();
  for (const line of lines) {
    byRate.set(line.iva, (byRate.get(line.iva) ?? 0) + line.base);
  }
  const ivaDesglose = [...byRate.entries()]
    .sort(([a], [b]) => b - a)
    .map(([tipo, rateBase]) => ({ tipo, base: rateBase, cuota: percentOf(rateBase, tipo, 'iva') }));
  const iva = ivaDesglose.reduce((sum, row) => sum + row.cuota, 0);

  const irpfBase = lines.filter((l) => l.tipo === 'servicio').reduce((sum, l) => sum + l.base, 0);
  const irpf = percentOf(irpfBase, irpfRate, 'irpf');

  const total = base + iva - irpf;
  return {
    base,
    iva,
    ivaDesglose,
    irpfTipo: irpfRate,
    irpfBase,
    irpf,
    total,
    yaPagado: alreadyPaid,
    pendiente: total - alreadyPaid,
  };
}

/** Validates the tool input and returns the normalized draft content with its totals. */
export function buildDraftContent(input: DraftInput, defaultIrpf: number): DraftContent {
  const c = input.cliente;
  if (!c) throw new ValidationError('cliente: obligatorio');
  const nif = normalizeNif(requireText(c.nif, 'cliente.nif', 20));
  if (!isValidNif(nif)) {
    throw new ValidationError(`cliente.nif: "${c.nif}" no es un NIF/CIF/NIE válido (revisa la letra de control)`);
  }
  const d = c.direccion;
  if (!d) throw new ValidationError('cliente.direccion: obligatoria');
  const pais = d.pais?.trim();
  const cliente: Client = {
    nombre: requireText(c.nombre, 'cliente.nombre'),
    nif,
    direccion: {
      calle: requireText(d.calle, 'cliente.direccion.calle'),
      ...(d.numero?.trim() ? { numero: d.numero.trim() } : {}),
      cp: requireText(d.cp, 'cliente.direccion.cp', 20),
      ciudad: requireText(d.ciudad, 'cliente.direccion.ciudad', 100),
      provincia: requireText(d.provincia, 'cliente.direccion.provincia', 100),
      ...(pais ? { pais } : {}),
    },
    ...(c.email?.trim() ? { email: c.email.trim() } : {}),
  };
  if (!pais || /^(es|españa|espana|spain)$/i.test(pais)) {
    if (!/^\d{5}$/.test(cliente.direccion.cp)) {
      throw new ValidationError('cliente.direccion.cp: un código postal español tiene 5 dígitos');
    }
  }

  const irpf = input.irpf ?? defaultIrpf;
  if (!(IRPF_RATES as readonly number[]).includes(irpf)) {
    throw new ValidationError(`irpf: ${irpf} % no es un tipo válido (${IRPF_RATES.join(', ')})`);
  }

  if (!Array.isArray(input.lineas) || input.lineas.length === 0) {
    throw new ValidationError('lineas: la factura necesita al menos una línea');
  }
  if (input.lineas.length > 100) {
    throw new ValidationError('lineas: máximo 100 líneas');
  }
  const lineas: Line[] = input.lineas.map((raw, i) => {
    const field = `lineas[${i}]`;
    const cantidad = raw.cantidad ?? 1;
    if (!(cantidad > 0)) throw new ValidationError(`${field}.cantidad: debe ser mayor que 0`);
    if (!(raw.precio_unitario >= 0)) {
      throw new ValidationError(`${field}.precio_unitario: no puede ser negativo`);
    }
    if (raw.tipo !== 'servicio' && raw.tipo !== 'bien') {
      throw new ValidationError(`${field}.tipo: "servicio" o "bien"`);
    }
    const iva = raw.iva ?? 21;
    if (!(IVA_RATES as readonly number[]).includes(iva)) {
      throw new ValidationError(`${field}.iva: ${iva} % no soportado (${IVA_RATES.join(', ')})`);
    }
    return {
      descripcion: requireText(raw.descripcion, `${field}.descripcion`, 2000),
      cantidad,
      precio_unitario: raw.precio_unitario,
      tipo: raw.tipo,
      iva,
      irpf: raw.tipo === 'servicio' ? irpf : 0,
      base: lineBase(cantidad, raw.precio_unitario, field),
    };
  });

  const yaPagado = eurosToCents(input.ya_pagado ?? 0, 'ya_pagado');
  if (yaPagado < 0) throw new ValidationError('ya_pagado: no puede ser negativo');

  const totales = computeTotals(lineas, irpf, yaPagado);
  if (totales.total <= 0) throw new ValidationError('El total de la factura debe ser mayor que 0');
  if (yaPagado > totales.total) {
    throw new ValidationError('ya_pagado: no puede superar el total de la factura');
  }

  if (input.fecha_operacion !== undefined && !isRealDate(input.fecha_operacion)) {
    throw new ValidationError('fecha_operacion: formato AAAA-MM-DD');
  }
  const notas = input.notas?.trim();
  if (notas && notas.length > 600) {
    throw new ValidationError('notas: máximo 600 caracteres');
  }

  return {
    cliente,
    lineas,
    irpf,
    ...(input.fecha_operacion ? { fecha_operacion: input.fecha_operacion } : {}),
    ...(notas ? { notas } : {}),
    totales,
  };
}
