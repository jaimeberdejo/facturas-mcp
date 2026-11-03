#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { collectEnv, loadConfig } from './config.js';
import { providerFactory } from './providers/index.js';
import { createServer } from './server.js';
import { LocalStore } from './store.js';

/** Today's date in Spain (YYYY-MM-DD). Invoice dates follow Spanish time, not UTC. */
function todayInSpain(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
}

async function main(): Promise<void> {
  const config = loadConfig(collectEnv());
  const store = new LocalStore(config.dataDir, config.env);
  const deps = {
    config,
    store,
    getProvider: providerFactory(config, { today: todayInSpain }),
    today: todayInSpain,
    now: () => new Date(),
  };
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  // stdout belongs to the MCP protocol; logs go to stderr.
  console.error(`facturas-mcp listo · entorno=${config.env} · proveedor=${config.provider} · datos=${store.root}`);
}

main().catch((error: unknown) => {
  console.error(`facturas-mcp no pudo arrancar: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
