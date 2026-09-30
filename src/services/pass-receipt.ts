/**
 * 6.1 — Per-pass `pass_receipt`: audit, not log-grep.
 *
 * Today we diagnose `fired=0` by grepping `[PREFILTER REJECTS]` / `[STALE GATE]`
 * lines. This promotes that to an immutable per-pass record — timestamp, chains
 * scanned, candidate count by source, budget spent, sources that failed/degraded,
 * and gate outcomes — written beside the existing diagnostics. Turns "did the bot
 * fire" from log-grep into a queryable fact.
 *
 * Durable (JSONL + optional Postgres mirror), interface-preserving, fail-open.
 */

import fs from 'fs';
import path from 'path';

export interface PassGateOutcome {
  beforeGate: number;
  afterGate: number;
  /** How many signals the consensus/selector gate rejected. */
  rejectedByGate: number;
  /** Signal types/sources that fired (post-gate). */
  fired: string[];
}

export interface PassReceipt {
  /** ISO timestamp of the pass start. */
  at: string;
  /** Domains/agents that ran this pass. */
  domains: string[];
  /** Chains scanned this pass. */
  chains: string[];
  /** Candidate count by discovery source id. */
  candidateCountBySource: Record<string, number>;
  /** Normalized/prefiltered candidate count. */
  candidatesNormalized: number;
  /** Credit/call budget spent this pass (USD or credits). */
  budgetSpent?: number;
  /** Sources that failed or degraded this pass (id -> failure class). */
  sourcesFailed?: Record<string, string>;
  /** Gate outcomes: before/after and fired. */
  gate: PassGateOutcome;
}

export interface PassReceiptIO {
  append(receipt: PassReceipt): void;
}

export const DEFAULT_PASS_RECEIPT_FILE = path.resolve('database', 'pass-receipts.jsonl');

function passPostgresUrl(): string | null {
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URI ?? process.env.POSTGRES_CONNECTION_STRING ?? null;
}

/** File-backed PassReceiptIO — one JSON line per pass (JSONL). */
export function filePassReceiptIO(filePath: string = DEFAULT_PASS_RECEIPT_FILE): PassReceiptIO {
  return {
    append: (receipt: PassReceipt) => {
      try {
        const absolutePath = path.resolve(filePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.appendFileSync(absolutePath, `${JSON.stringify(receipt)}\n`, 'utf-8');
      } catch (error) {
        console.warn(`[PASS RECEIPT] failed to append ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/** Postgres-backed PassReceiptIO — appends each receipt as a JSONB row. Fail-open, lazy pool. */
export function pgPassReceiptIO(url: string = passPostgresUrl() ?? ''): PassReceiptIO {
  const dbUrl = url || null;
  let pool: any = null;
  let ready = false;
  const ensurePool = async (): Promise<any> => {
    if (!dbUrl) return null;
    if (!pool) {
      const { default: Pg } = await import('pg');
      pool = new Pg.Pool({ connectionString: dbUrl, max: 2 });
    }
    if (!ready) {
      try { await pool.query('SELECT 1'); ready = true; } catch { /* retry on next append */ }
    }
    return ready ? pool : null;
  };
  return {
    append: (receipt: PassReceipt) => {
      if (!dbUrl) return;
      void ensurePool()
        .then((p) => p?.query('INSERT INTO pass_receipts (payload, created_at) VALUES ($1, $2)', [JSON.stringify(receipt), Date.now()]))
        .catch(() => { /* fail-open */ });
    },
  };
}

/** Read all durable pass receipts (newest last). Postgres when a URL is present, else JSONL. */
export async function readPassReceipts(opts?: { url?: string; file?: string }): Promise<PassReceipt[]> {
  const url = opts?.url ?? passPostgresUrl();
  const receipts: PassReceipt[] = [];
  if (url) {
    try {
      const { default: Pg } = await import('pg');
      const pool = new Pg.Pool({ connectionString: url, max: 2 });
      const { rows } = await pool.query<{ payload: string }>('SELECT payload FROM pass_receipts');
      await pool.end();
      for (const r of rows) {
        try { receipts.push(JSON.parse(r.payload) as PassReceipt); } catch { /* skip bad row */ }
      }
      return receipts;
    } catch (err) {
      console.warn(`[PASS RECEIPT] failed to load: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  const filePath = path.resolve(opts?.file ?? DEFAULT_PASS_RECEIPT_FILE);
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { receipts.push(JSON.parse(line) as PassReceipt); } catch { /* skip bad line */ }
    }
  } catch { /* no file yet */ }
  return receipts;
}

/**
 * Immutable per-pass audit sink. Writes beside the existing diagnostics so "did
 * the bot fire" is a queryable fact, not a log-grep. Fail-open (a write error
 * never throws into the pass).
 */
export class PassReceiptLedger {
  constructor(private readonly io?: PassReceiptIO) {}

  /** Record one pass receipt (immutable). Fail-open — a write error never throws into the pass. */
  public record(receipt: PassReceipt): void {
    try {
      this.io?.append(receipt);
    } catch (error) {
      console.warn(`[PASS RECEIPT] write failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Convenience — whether the last recorded pass fired anything (for the stale-gate detector). */
  public async lastFired(opts?: { url?: string; file?: string }): Promise<boolean | null> {
    const all = await readPassReceipts(opts);
    if (all.length === 0) return null;
    return all[all.length - 1]!.gate.fired.length > 0;
  }
}

/** Create the default receipt ledger: Postgres-backed when a DB URL is set, else file-backed. */
export function createDefaultPassReceiptLedger(): PassReceiptLedger {
  const url = passPostgresUrl();
  return new PassReceiptLedger(url ? pgPassReceiptIO(url) : filePassReceiptIO());
}

/** Process-wide pass-receipt ledger for the screening cycle. */
export const globalPassReceiptLedger = createDefaultPassReceiptLedger();
