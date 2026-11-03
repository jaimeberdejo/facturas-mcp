/** Input that cannot become a valid invoice (bad NIF, empty lines, paid > total…). */
export class ValidationError extends Error {
  override name = 'ValidationError';
}

/** A safety rule refused the operation (missing confirm, production without the env flag…). */
export class RefusedError extends Error {
  override name = 'RefusedError';
}

/** The server is misconfigured (missing key, key for the wrong environment…). */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * The provider call failed.
 *
 * - `rejected`: the provider refused before registering anything (validation, auth,
 *   rate limit). The reserved number was not used and can be released.
 * - `unknown`: we cannot tell whether the invoice was registered (network error,
 *   timeout, 5xx). The number stays reserved for this draft until a retry settles it.
 */
export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    message: string,
    readonly outcome: 'rejected' | 'unknown',
    readonly details: { status?: number; code?: string } = {},
  ) {
    super(message);
  }
}
