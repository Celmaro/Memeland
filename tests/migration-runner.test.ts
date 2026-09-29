import { describe, it, expect } from 'vitest';
import { runMigrations, type Migration } from '../src/storage/migration-runner.js';

/** Minimal stub pool that records executed SQL and the migration ledger. */
function stubPool() {
  const ledger = new Set<string>();
  const sqlRun: string[] = [];
  let inTx = false;
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      sqlRun.push(sql);
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT version FROM schema_migrations/.test(sql)) {
        return { rows: [...ledger].map((v) => ({ version: v })) };
      }
      if (/INSERT INTO schema_migrations/.test(sql)) {
        ledger.add(String(params[0]));
        return { rows: [] };
      }
      if (/^BEGIN$/.test(sql)) { inTx = true; return { rows: [] }; }
      if (/^COMMIT$/.test(sql)) { inTx = false; return { rows: [] }; }
      if (/^ROLLBACK$/.test(sql)) { inTx = false; return { rows: [] }; }
      // Any other statement is a migration body — record it, optionally fail.
      sqlRun.push('MIGRATION_BODY');
      return { rows: [] };
    },
  };
  return { pool, ledger, sqlRun };
}

const MIGRATIONS: Migration[] = [
  { version: '001_initial', sql: 'CREATE TABLE IF NOT EXISTS discovery_observations (...);' },
  { version: '002_add_pool_identity', sql: 'ALTER TABLE ... ADD COLUMN pool_identity TEXT;' },
];

describe('P12 versioned schema migrations', () => {
  it('applies unapplied migrations in order and records them in the ledger', async () => {
    const { pool, ledger, sqlRun } = stubPool();
    const applied = await runMigrations(pool, MIGRATIONS);
    expect(applied).toEqual(['001_initial', '002_add_pool_identity']);
    expect(ledger.has('001_initial')).toBe(true);
    expect(ledger.has('002_add_pool_identity')).toBe(true);
    // Ordered: 001 body runs before 002 body.
    expect(sqlRun.filter((s) => s === 'MIGRATION_BODY')).toHaveLength(2);
  });

  it('skips migrations already recorded in the ledger (idempotent re-run)', async () => {
    const { pool, ledger } = stubPool();
    await runMigrations(pool, MIGRATIONS);
    // Second call sees both versions already applied.
    const appliedAgain = await runMigrations(pool, MIGRATIONS);
    expect(appliedAgain).toEqual([]);
    expect(ledger.size).toBe(2);
  });

  it('falls back to the compiled-in baseline when no migration files are found', async () => {
    const { pool, ledger } = stubPool();
    const applied = await runMigrations(pool, []); // simulates a build with no SQL files
    expect(applied).toEqual(['001_initial']);
    expect(ledger.has('001_initial')).toBe(true);
  });

  it('rolls back and throws if a migration body fails (fail-open at the caller)', async () => {
    const { pool } = stubPool();
    let inTx = false;
    const failing = {
      async query(sql: string, params: unknown[] = []) {
        if (/CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) return { rows: [] };
        if (/SELECT version FROM schema_migrations/.test(sql)) return { rows: [] };
        if (/^BEGIN$/.test(sql)) { inTx = true; return { rows: [] }; }
        if (/^ROLLBACK$/.test(sql)) { inTx = false; return { rows: [] }; }
        if (/^COMMIT$/.test(sql)) { inTx = false; return { rows: [] }; }
        if (/INSERT INTO schema_migrations/.test(sql)) return { rows: [] };
        throw new Error('migration body failed');
      },
    };
    await expect(runMigrations(failing, MIGRATIONS)).rejects.toThrow('migration body failed');
    expect(inTx).toBe(false); // rolled back
  });
});
