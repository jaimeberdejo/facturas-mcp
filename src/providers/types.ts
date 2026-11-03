import type { IssuerConfig } from '../config.js';
import type { Draft, Environment, Issue } from '../invoice.js';
import type { Cents } from '../money.js';

export interface IssueRequest {
  draft: Draft;
  /** Number our series expects for this invoice (e.g. "2026003"). */
  expectedNumber: string;
  issuer: IssuerConfig;
  /**
   * True when an earlier attempt for this draft ended with an unknown outcome, so the provider
   * may already hold the invoice. False on a first attempt: nothing can exist yet.
   */
  retry: boolean;
}

export interface IssueResult {
  /** Provider's id for the invoice (used to fetch the PDF later). */
  providerId: string;
  /** Number the provider actually assigned. Should equal `expectedNumber`. */
  number: string;
  /** YYYY-MM-DD */
  issueDate: string;
  /** Provider's totals, to cross-check our own computation. */
  totals?: { base: Cents; iva: Cents; irpf: Cents; total: Cents };
  verifactuStatus?: string;
}

export interface PdfFile {
  data: Uint8Array;
  fileName?: string;
}

/**
 * Adapter over a VERI*FACTU-compliant invoicing provider. The provider is the SIF: it keeps
 * the hash chain, sends the record to AEAT and renders the PDF with the QR. We never do.
 */
export interface InvoiceProvider {
  readonly name: string;
  readonly environment: Environment;
  /** Registers and issues the invoice. Irreversible on a real provider. */
  issueInvoice(request: IssueRequest): Promise<IssueResult>;
  downloadPdf(draft: Draft & { emision: Issue }): Promise<PdfFile>;
}
