import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationError } from './errors.js';
import type { Draft, Environment } from './invoice.js';
import type { SeriesState } from './numbering.js';

/**
 * Local JSON store, one folder per environment:
 *
 *   <dataDir>/<env>/borradores/<id>.json   drafts and issued invoices
 *   <dataDir>/<env>/serie.json             issued numbers and the pending reservation
 *
 * Writes go to a temp file and are renamed into place, so a crash never leaves half a JSON.
 */
export class LocalStore {
  readonly root: string;
  private readonly draftsDir: string;
  private readonly seriesFile: string;

  constructor(dataDir: string, env: Environment) {
    this.root = join(dataDir, env);
    this.draftsDir = join(this.root, 'borradores');
    this.seriesFile = join(this.root, 'serie.json');
    mkdirSync(this.draftsDir, { recursive: true, mode: 0o700 });
  }

  newDraftId(): string {
    return `bor_${randomBytes(4).toString('hex')}`;
  }

  saveDraft(draft: Draft): void {
    writeJsonAtomic(join(this.draftsDir, `${draft.id}.json`), draft);
  }

  getDraft(id: string): Draft | undefined {
    if (!/^bor_[0-9a-f]{8}$/.test(id)) {
      throw new ValidationError(`"${id}" no es un id de borrador (formato bor_xxxxxxxx)`);
    }
    const path = join(this.draftsDir, `${id}.json`);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as Draft;
  }

  listDrafts(): Draft[] {
    return readdirSync(this.draftsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(this.draftsDir, name), 'utf8')) as Draft);
  }

  findByNumber(numero: string): Draft | undefined {
    return this.listDrafts().find((d) => d.emision?.numero === numero);
  }

  loadSeries(): SeriesState {
    if (!existsSync(this.seriesFile)) return { emitidas: [] };
    return JSON.parse(readFileSync(this.seriesFile, 'utf8')) as SeriesState;
  }

  saveSeries(state: SeriesState): void {
    writeJsonAtomic(this.seriesFile, state);
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
