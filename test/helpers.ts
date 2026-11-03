import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildDraftContent, type Draft, type DraftInput } from '../src/invoice.js';
import { MockProvider } from '../src/providers/mock.js';
import { LocalStore } from '../src/store.js';

/** A throwaway data folder per test, so tests never touch ./data. */
export function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'facturas-mcp-test-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export interface Harness {
  config: Config;
  store: LocalStore;
  provider: MockProvider;
  today: () => string;
  now: () => Date;
  setToday: (date: string) => void;
  addDraft: (input: DraftInput) => Draft;
  cleanup: () => void;
}

export function harness(env: Record<string, string> = {}): Harness {
  const dir = tempDir();
  let today = '2026-11-03';
  // The default start of the series is the first number of today's year: 2026001.
  const config = loadConfig({ FACTURAS_DATA_DIR: dir.path, ...env }, today);
  const store = new LocalStore(config.dataDir, config.env);
  const provider = new MockProvider(() => today);
  return {
    config,
    store,
    provider,
    today: () => today,
    now: () => new Date(`${today}T10:00:00Z`),
    setToday: (date) => {
      today = date;
    },
    addDraft: (input) => {
      const draft: Draft = {
        id: store.newDraftId(),
        estado: 'borrador',
        entorno: config.env,
        creado: `${today}T10:00:00.000Z`,
        ...buildDraftContent(input, config.irpfPorDefecto),
      };
      store.saveDraft(draft);
      return draft;
    },
    cleanup: dir.cleanup,
  };
}
