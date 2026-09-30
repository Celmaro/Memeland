/**
 * P0.4 — TraderPersistence (provider-architecture v2: durable market moat).
 *
 * Backs the leaderboard pipeline from the research report: leaderboard →
 * identity resolve → wallet → PnL persistence → the **24h ∩ 7d ∩ 30d
 * intersection**, i.e. traders who are profitable/active on ALL three windows
 * are genuinely *persistent* — the cohort most likely to front-run again.
 *
 * Ingest leaderboard rows each cycle (any provider that exposes trader PnL by
 * window, chiefly FOMO API `/v2/leaderboard/{24h|7d|30d}`). `persistentTraders`
 * returns the intersection with aggregate PnL/volume. Lineage keeps the
 * audit trail the second-opinion review asked for (#13/#14):
 *   Observation (raw rows) → Feature (computed persistence signal) →
 *   Inference (persistent trader, with the evidence behind it).
 */

import fs from 'fs';
import path from 'path';
import { WalletGraph } from './wallet-graph.js';

export type PnlWindow = '24h' | '7d' | '30d' | 'all';

export interface TraderWindowRow {
  handle: string;
  window: PnlWindow;
  pnlPct: number;
  volumeUsd: number;
  solWallet?: string;
  evmWallet?: string;
  chain?: string;
  /** Leaderboard provider (gmgn/fomo/pumpdev). */
  provider?: string;
  /** Rank within the leaderboard. */
  rank?: number;
  /** Epoch ms when this board observation was fetched (P0 time-correctness). */
  fetchedAt?: number;
}

export interface PersistentTrader {
  handle: string;
  chain: string;
  /** The FRESH windows the trader currently appears in (for true persistence, all 3). */
  windowsPresent: PnlWindow[];
  /** Latest on-chain wallet ids resolved for the trader. */
  wallets: { sol?: string; evm?: string };
  /** Mean PnL % across the present (fresh) windows. */
  avgPnlPct: number;
  /** Total volume USD across present (fresh) windows. */
  totalVolumeUsd: number;
  /** STRICT persistence = fresh in 24h AND 7d AND 30d (current board epoch). */
  strictPersistent: boolean;
  /** Latest board-fetch timestamp across the trader's observations. */
  lastSeenAt?: number;
  /** Lineage for ML/audit (Observation/Feature/Inference). */
  lineage: { observations: number; feature: string; inference: string };
}

const STRICT: PnlWindow[] = ['24h', '7d', '30d'];
const WINDOW_RANK: Record<PnlWindow, number> = { '24h': 0, '7d': 1, '30d': 2, all: 3 };

/**
 * P0 freshness budget: how old a board observation may be for that window to
 * count as "currently present". A 24h row fetched last week must NOT count as
 * current 24h presence — that is exactly the stale-accumulation bug the review
 * flagged. Tuned so a board re-fetched on the normal cadence stays current.
 */
const DEFAULT_FRESHNESS_MS: Record<PnlWindow, number> = {
  '24h': 6 * 3600_000, // 6h
  '7d': 24 * 3600_000, // 1d
  '30d': 3 * 24 * 3600_000, // 3d
  all: 6 * 3600_000,
};

export interface TraderPersistenceOptions {
  /** Per-window freshness overrides (ms). */
  freshnessMs?: Partial<Record<PnlWindow, number>>;
  now?: () => number;
}

export class TraderPersistence {
  /** handle → window → weighted row (keeps the newest/richest per window). */
  private rows = new Map<string, Map<string, TraderWindowRow>>();
  private observations = 0;
  private readonly freshnessMs: Record<PnlWindow, number>;
  private readonly now: () => number;

  constructor(opts: TraderPersistenceOptions = {}, private readonly io?: TraderRowIO) {
    this.freshnessMs = { ...DEFAULT_FRESHNESS_MS, ...(opts.freshnessMs ?? {}) };
    this.now = opts.now ?? (() => Date.now());
  }

  /** Ingest one leaderboard observation for a window. */
  public ingest(row: TraderWindowRow): void {
    if (this.applyIngest(row)) this.io?.append(row);
  }

  /** Ingest mutation only (no io append) — returns true when a row was kept. */
  private applyIngest(row: TraderWindowRow): boolean {
    const fetchedAt = row.fetchedAt ?? this.now();
    const byWindow = this.rows.get(row.handle) ?? new Map<string, TraderWindowRow>();
    const key = row.window;
    const prev = byWindow.get(key);
    // Keep the observation with the larger volume (richer) or the newer one.
    // Staleness is driven by fetchedAt + the freshness budget, so a rich but
    // old row decays out of "current" presence automatically.
    if (!prev || row.volumeUsd > prev.volumeUsd || fetchedAt > (prev.fetchedAt ?? 0)) {
      byWindow.set(key, { ...row, fetchedAt: row.fetchedAt ?? fetchedAt });
      this.observations += 1;
    } else {
      return false;
    }
    this.rows.set(row.handle, byWindow);
    return true;
  }

  /**
   * P9 — rebuild the persistence ledger from a durable row history after a
   * restart (re-applies the richer/newer rule per handle+window). Applies only
   * when the ledger is empty this process, so it never clobbers live divergence.
   */
  public hydrate(rows: TraderWindowRow[]): void {
    if (this.rows.size > 0) return;
    for (const r of rows) this.applyIngest(r);
  }

  /** Trader ids seen at least once. */
  public handles(): string[] {
    return [...this.rows.keys()];
  }

  /** True when a window observation is recent enough to count as current. */
  private isFresh(window: PnlWindow, fetchedAt: number | undefined, nowMs: number): boolean {
    if (fetchedAt === undefined) return true; // no timestamp → assume current (back-compat)
    return nowMs - fetchedAt <= this.freshnessMs[window];
  }

  /**
   * Persistent traders. With `strictOnly` (default true) only traders FRESHLY
   * present in ALL of 24h/7d/30d at `nowMs` are returned — the durable,
   * time-current leaderboard signal. `nowMs` defaults to the current clock.
   */
  public persistentTraders(strictOnly = true, nowMs?: number): PersistentTrader[] {
    const now = nowMs ?? this.now();
    const out: PersistentTrader[] = [];
    for (const [handle, byWindow] of this.rows) {
      const present: TraderWindowRow[] = [];
      const windowsPresent: PnlWindow[] = [];
      let lastSeenAt = 0;
      for (const w of STRICT) {
        const r = byWindow.get(w);
        if (!r) continue;
        if ((r.fetchedAt ?? 0) > lastSeenAt) lastSeenAt = r.fetchedAt ?? 0;
        if (!this.isFresh(w, r.fetchedAt, now)) continue; // stale → not current
        present.push(r);
        windowsPresent.push(w);
      }
      const strict = STRICT.every((w) => {
        const r = byWindow.get(w);
        return !!r && this.isFresh(w, r.fetchedAt, now);
      });
      if (strictOnly && !strict) continue;
      const chain = present[0]?.chain ?? 'solana';
      const totalVolume = present.reduce((s, r) => s + r.volumeUsd, 0);
      const avgPnl = present.length > 0 ? present.reduce((s, r) => s + r.pnlPct, 0) / present.length : 0;
      const solWallet = pickFresh(present, 'solWallet');
      const evmWallet = pickFresh(present, 'evmWallet');
      out.push({
        handle,
        chain,
        windowsPresent,
        wallets: { sol: solWallet, evm: evmWallet },
        avgPnlPct: avgPnl,
        totalVolumeUsd: totalVolume,
        strictPersistent: strict,
        lastSeenAt: lastSeenAt > 0 ? lastSeenAt : undefined,
        lineage: {
          observations: present.length,
          feature: `persistent_window_intersection_${[...windowsPresent].sort().join('+')}`,
          inference: strict
            ? 'persistent_trader_24_7_30'
            : 'cross_window_trader',
        },
      });
    }
    // Rank persistent traders by total volume (the whales who survive all windows).
    return out.sort((a, b) => b.totalVolumeUsd - a.totalVolumeUsd);
  }

  public stats(): { handles: number; observations: number; persistent: number } {
    return {
      handles: this.rows.size,
      observations: this.observations,
      persistent: this.persistentTraders().length,
    };
  }
}

/** The most recently-seen non-empty value for a field across window rows. */
function pickFresh(rows: TraderWindowRow[], field: 'solWallet' | 'evmWallet'): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = rows[i]![field];
    if (v) return v;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * P9 — durable trader persistence. The leaderboard ledger was          *
 * process-local, so the 24h∩7d∩30d persistence signal (and the          *
 * regime-coverage unlock) reset on restart. Mirror P7/P8: durable       *
 * row sink + restart hydration.                                         *
 * ------------------------------------------------------------------ */

/** Durable sink for ingested leaderboard observations. */
export interface TraderRowIO {
  append(row: TraderWindowRow): void;
}

export const DEFAULT_TRADER_FILE = path.resolve('database', 'trader-persistence.jsonl');

/** Resolve the Postgres connection string for the durable trader ledger. */
function traderPostgresUrl(): string | null {
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URI ?? process.env.POSTGRES_CONNECTION_STRING ?? null;
}

/** File-backed TraderRowIO — one JSON line per ingested observation (JSONL). */
export function fileTraderRowIO(filePath: string = DEFAULT_TRADER_FILE): TraderRowIO {
  return {
    append: (row: TraderWindowRow) => {
      try {
        const absolutePath = path.resolve(filePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.appendFileSync(absolutePath, `${JSON.stringify(row)}\n`, 'utf-8');
      } catch (error) {
        console.warn(`[TRADER] failed to append ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/** Postgres-backed TraderRowIO — upsert by (handle, window) so the latest state wins. Fail-open, lazy pool. */
export function pgTraderRowIO(url: string = traderPostgresUrl() ?? ''): TraderRowIO {
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
    append: (row: TraderWindowRow) => {
      if (!dbUrl) return;
      void ensurePool()
        .then((p) =>
          p?.query(
            `INSERT INTO trader_rows (handle, window, payload, updated_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT (handle, window) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
            [row.handle.toLowerCase(), row.window, JSON.stringify(row), row.fetchedAt ?? Date.now()],
          ),
        )
        .catch(() => { /* fail-open */ });
    },
  };
}

/** Load durable trader observations as TraderWindowRow[]. Postgres when a URL is present, else JSONL. */
export async function loadTraderRows(opts?: { url?: string; file?: string }): Promise<TraderWindowRow[]> {
  const url = opts?.url ?? traderPostgresUrl();
  const rows: TraderWindowRow[] = [];
  if (url) {
    try {
      const { default: Pg } = await import('pg');
      const pool = new Pg.Pool({ connectionString: url, max: 2 });
      const { rows: dbRows } = await pool.query<{ payload: string }>('SELECT payload FROM trader_rows');
      await pool.end();
      for (const r of dbRows) {
        try { rows.push(JSON.parse(r.payload) as TraderWindowRow); } catch { /* skip bad row */ }
      }
      return rows;
    } catch (err) {
      console.warn(`[TRADER] failed to load durable rows: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  const filePath = path.resolve(opts?.file ?? DEFAULT_TRADER_FILE);
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line) as TraderWindowRow); } catch { /* skip bad line */ }
    }
  } catch { /* no file yet */ }
  return rows;
}

/** Create the default persistence ledger: Postgres-backed (with hydration) when a DB URL is present, else file-backed. */
export function createDefaultTraderPersistence(): TraderPersistence {
  const url = traderPostgresUrl();
  const tp = new TraderPersistence({}, url ? pgTraderRowIO(url) : fileTraderRowIO());
  if (url) {
    void loadTraderRows({ url })
      .then((rs) => { if (rs.length > 0) tp.hydrate(rs); })
      .catch(() => { /* hydration is best-effort */ });
  }
  return tp;
}

/** Process-wide persistence ledger for the screening cycle (durable when a DB URL is set). */
export const globalTraderPersistence = createDefaultTraderPersistence();

/**
 * Phase 4 — a wallet-native cohort: one connected wallet cluster (one economic
 * actor) with PnL/volume folded up from every handle attached to it.
 */
export interface WalletNativeCohort {
  /** Deterministic id — first handle, else lowest wallet in the cluster. */
  cohortId: string;
  wallets: string[];
  handles: string[];
  chains: string[];
  providers: string[];
  /** How many persistent traders collapsed into this one cohort. */
  collapsedTraders: number;
  /** Sum of totalVolumeUsd across present persistent handles in the cohort. */
  totalVolumeUsd: number;
  /** Mean avgPnlPct across present persistent handles in the cohort. */
  avgPnlPct: number;
  /** Handles freshly present on all of 24h/7d/30d (strict persistence). */
  strictCount: number;
}

/**
 * Phase 4 — wallet-native cohorts over a WalletGraph. This is the anti
 * double-count: N provider handles sharing a wallet cluster are ONE trader.
 * Handles with no resolution (no wallet, not in the graph) are reported as
 * singletons so we never silently drop a persistent trader.
 */
export function walletNativeCohorts(persistence: TraderPersistence, graph: WalletGraph): WalletNativeCohort[] {
  const present = persistence.persistentTraders(false); // all present (incl non-strict)
  // Map each resolvable handle to its (batch) cohort via the graph.
  const byHandle = new Map(present.map((p) => [p.handle.toLowerCase(), p]));

  // Build raw cohorts keyed by canonical cluster id.
  const raw = new Map<string, {
    wallets: Set<string>;
    handles: string[];
    chains: Set<string>;
    providers: Set<string>;
    members: PersistentTrader[];
  }>();

  const ensure = (id: string) => {
    if (!raw.has(id)) raw.set(id, { wallets: new Set(), handles: [], chains: new Set(), providers: new Set(), members: [] });
    return raw.get(id)!;
  };

  for (const trader of present) {
    const resolved = graph.resolveTrader(trader.handle);
    if (!resolved || resolved.wallets.length === 0) {
      // Unresolved handle → singleton cohort keyed by its own handle.
      const c = ensure(trader.handle.toLowerCase());
      c.handles.push(trader.handle);
      c.members.push(trader);
      continue;
    }
    const c = ensure(resolved.canonicalId);
    c.handles.push(trader.handle);
    for (const w of resolved.wallets) c.wallets.add(w);
    for (const ch of resolved.chains) c.chains.add(ch);
    for (const p of resolved.providers) c.providers.add(p);
    c.members.push(trader);
  }

  const out: WalletNativeCohort[] = [];
  for (const [, c] of raw) {
    const totalVolume = c.members.reduce((s, m) => s + m.totalVolumeUsd, 0);
    const strictCount = c.members.filter((m) => m.strictPersistent).length;
    const avgPnl = c.members.length > 0 ? c.members.reduce((s, m) => s + m.avgPnlPct, 0) / c.members.length : 0;
    out.push({
      cohortId: c.handles[0] ?? [...c.wallets].sort()[0] ?? 'unknown',
      wallets: [...c.wallets],
      handles: c.handles,
      chains: [...c.chains],
      providers: [...c.providers],
      collapsedTraders: c.handles.length,
      totalVolumeUsd: totalVolume,
      avgPnlPct: avgPnl,
      strictCount,
    });
  }
  // Rank cohorts by volume (the whales that survive all windows), singletons last.
  return out.sort((a, b) => b.totalVolumeUsd - a.totalVolumeUsd);
}