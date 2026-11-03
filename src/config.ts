import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { ConfigError } from './errors.js';
import { IRPF_RATES, type Environment } from './invoice.js';
import { parseInvoiceNumber } from './numbering.js';

export type ProviderName = 'mock' | 'beel';

export interface IssuerConfig {
  nombre?: string;
  nif?: string;
  direccion?: string;
  iban?: string;
  email?: string;
}

export interface BeelConfig {
  apiKey?: string;
  companyId?: string;
  seriesId?: string;
  baseUrl: string;
}

export interface Config {
  env: Environment;
  provider: ProviderName;
  /** Root data folder. Each environment gets its own subfolder, so sandbox never touches production numbers. */
  dataDir: string;
  /** Where issued PDFs are written. Defaults to <dataDir>/<env>/pdf. */
  pdfDir: string;
  /** First number of the series, e.g. "2026003". */
  numeroInicial: string;
  /** IRPF % applied to service lines when the draft does not say otherwise. */
  irpfPorDefecto: number;
  issuer: IssuerConfig;
  beel: BeelConfig;
}

export const BEEL_DEFAULT_BASE_URL = 'https://app.beel.es/api';

/** Repository root (one level above src/ or dist/). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Default config file outside the repo, so personal data and keys never sit in the working tree. */
export const DEFAULT_CONFIG_FILE = join(homedir(), '.config', 'facturas-mcp', '.env');

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
}

/**
 * Merges configuration sources. Precedence, highest first:
 * 1. real environment variables (e.g. `claude mcp add -e KEY=value`),
 * 2. the config file (FACTURAS_CONFIG_FILE, default ~/.config/facturas-mcp/.env),
 * 3. a `.env` at the repo root (gitignored).
 */
export function collectEnv(processEnv: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const configFile = processEnv.FACTURAS_CONFIG_FILE || DEFAULT_CONFIG_FILE;
  return {
    ...readEnvFile(join(PACKAGE_ROOT, '.env')),
    ...readEnvFile(configFile),
    ...processEnv,
  };
}

function optional(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const rawEnv = optional(env.FACTURAS_ENV) ?? 'sandbox';
  if (rawEnv !== 'sandbox' && rawEnv !== 'production') {
    throw new ConfigError(`FACTURAS_ENV="${rawEnv}" no es válido: usa "sandbox" (por defecto) o "production"`);
  }
  const appEnv: Environment = rawEnv;

  const rawProvider = optional(env.FACTURAS_PROVIDER) ?? 'mock';
  if (rawProvider !== 'mock' && rawProvider !== 'beel') {
    throw new ConfigError(`FACTURAS_PROVIDER="${rawProvider}" no es válido: usa "mock" o "beel"`);
  }
  const provider: ProviderName = rawProvider;
  if (appEnv === 'production' && provider === 'mock') {
    throw new ConfigError('FACTURAS_ENV=production con el proveedor mock no tiene sentido: no registraría nada.');
  }

  const numeroInicial = optional(env.FACTURAS_NUMERO_INICIAL) ?? '2026003';
  parseInvoiceNumber(numeroInicial);

  const rawIrpf = optional(env.FACTURAS_IRPF_POR_DEFECTO) ?? '7';
  const irpfPorDefecto = Number(rawIrpf);
  if (!(IRPF_RATES as readonly number[]).includes(irpfPorDefecto)) {
    throw new ConfigError(`FACTURAS_IRPF_POR_DEFECTO="${rawIrpf}" no es un tipo de IRPF válido`);
  }

  const rawDataDir = optional(env.FACTURAS_DATA_DIR);
  const dataDir = rawDataDir
    ? isAbsolute(rawDataDir)
      ? rawDataDir
      : resolve(PACKAGE_ROOT, rawDataDir)
    : join(PACKAGE_ROOT, 'data');
  const rawPdfDir = optional(env.FACTURAS_PDF_DIR);
  const pdfDir = rawPdfDir ? resolve(PACKAGE_ROOT, rawPdfDir) : join(dataDir, appEnv, 'pdf');

  return {
    env: appEnv,
    provider,
    dataDir,
    pdfDir,
    numeroInicial,
    irpfPorDefecto,
    issuer: {
      nombre: optional(env.FACTURAS_EMISOR_NOMBRE),
      nif: optional(env.FACTURAS_EMISOR_NIF),
      direccion: optional(env.FACTURAS_EMISOR_DIRECCION),
      iban: optional(env.FACTURAS_EMISOR_IBAN)?.replace(/\s/g, ''),
      email: optional(env.FACTURAS_EMISOR_EMAIL),
    },
    beel: {
      apiKey: optional(env.BEEL_API_KEY),
      companyId: optional(env.BEEL_COMPANY_ID),
      seriesId: optional(env.BEEL_SERIES_ID),
      baseUrl: optional(env.BEEL_BASE_URL) ?? BEEL_DEFAULT_BASE_URL,
    },
  };
}
