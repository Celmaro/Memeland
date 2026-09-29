/**
 * P12 — versioned schema migrations.
 *
 * Replaces the inline `CREATE TABLE IF NOT EXISTS ...` blob coupled to runtime
 * code with an ordered, versioned migration set, applied once and tracked in a
 * `schema_migrations` table. A migration is never re-run once its version is
 * recorded, so schema evolution is explicit and versioned rather than living in
 * runtime code paths. Fail-open: the caller (ensurePool) swallows a failure and
 * keeps the in-memory mirror path, so a migration problem never blocks a pass.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Migration {
  /** Version id derived from the filename, e.g. "001_initial". */
  version: string;
  sql: string;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/**
 * Load `*.sql` migration files sorted by filename (= version order). Returns an
 * empty array when the dir is missing (e.g. a build that did not copy the SQL
 * files), so the runner can fall back to the compiled-in baseline rather than
 * throwing at pool setup.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), sql: readFileSync(`${dir}/${f}`, 'utf8') }));
}

/** Compiled-in baseline fallback when the migration dir is absent at runtime. */
const BASELINE_001 = `
CREATE TABLE IF NOT EXISTS discovery_observations (
  chain          TEXT NOT NULL,
  token_address  TEXT NOT NULL,
  source         TEXT NOT NULL,
  at             BIGINT NOT NULL,
  cost_credits   NUMERIC DEFAULT 0,
  PRIMARY KEY (chain, token_address, source, at)
);
CREATE INDEX IF NOT EXISTS idx_discovery_observations_at ON discovery_observations (at DESC);
`;

/**
 * Apply any migrations not yet recorded in `schema_migrations`, in order.
 * Idempotent and ordered. Throws on a migration failure so the caller can
 * fail-open. Returns the versions applied this call.
 */
export async function runMigrations(pool: any, migrations: Migration[] = loadMigrations()): Promise<string[]> {
  // Always ensure the migration ledger exists first.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at BIGINT NOT NULL
     )`,
  );
  const applied = new Set<string>();
  const ledgerRes = await pool.query('SELECT version FROM schema_migrations');
  for (const r of ledgerRes.rows ?? []) applied.add(String(r.version));

  // If no versioned files were found (build didn't copy SQL), fall back to the
  // compiled-in baseline so the durable path never silently degrades.
  const effective: Migration[] =
    migrations.length > 0 ? migrations : [{ version: '001_initial', sql: BASELINE_001 }];

  const appliedNow: string[] = [];
  for (const m of effective) {
    if (applied.has(m.version)) continue;
    await pool.query('BEGIN');
    try {
      await pool.query(m.sql);
      await pool.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [m.version, Date.now()],
      );
      await pool.query('COMMIT');
      appliedNow.push(m.version);
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }
  return appliedNow;
}
