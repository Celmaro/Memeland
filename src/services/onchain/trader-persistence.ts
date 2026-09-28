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

  constructor(opts: TraderPersistenceOptions = {}) {
    this.freshnessMs = { ...DEFAULT_FRESHNESS_MS, ...(opts.freshnessMs ?? {}) };
    this.now = opts.now ?? (() => Date.now());
  }

  /** Ingest one leaderboard observation for a window. */
  public ingest(row: TraderWindowRow): void {
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
    }
    this.rows.set(row.handle, byWindow);
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

/** Process-wide persistence ledger for the screening cycle. */
export const globalTraderPersistence = new TraderPersistence();