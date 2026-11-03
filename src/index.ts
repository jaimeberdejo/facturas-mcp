#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { collectEnv, loadConfig, todayInSpain } from './config.js';
import { providerFactory } from './providers/index.js';
import { createServer } from './server.js';
import { LocalStore } from './store.js';

async function main(): Promise<void> {
  const config = loadConfig(collectEnv(), todayInSpain());
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
