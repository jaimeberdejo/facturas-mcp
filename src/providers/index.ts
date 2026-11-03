import type { Config } from '../config.js';
import { BeelProvider } from './beel.js';
import { MockProvider } from './mock.js';
import type { InvoiceProvider } from './types.js';

/**
 * Lazily builds the provider. A missing or wrong key does not stop the server: drafts and
 * listing keep working, and the tools that need the provider explain what is missing.
 */
export function providerFactory(
  config: Config,
  options: { today: () => string; fetchFn?: typeof fetch },
): () => InvoiceProvider {
  let cached: InvoiceProvider | undefined;
  return () => {
    cached ??=
      config.provider === 'mock'
        ? new MockProvider(options.today)
        : new BeelProvider(config.beel, config.env, options.fetchFn);
    return cached;
  };
}

export type { InvoiceProvider } from './types.js';
