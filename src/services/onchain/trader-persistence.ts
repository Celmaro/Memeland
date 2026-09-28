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
}

export interface PersistentTrader {
  handle: string;
  chain: string;
  /** The windows the trader appeared in (for true persistence this is all 3). */
  windowsPresent: PnlWindow[];
  /** Latest on-chain wallet ids resolved for the trader. */
  wallets: { sol?: string; evm?: string };
  /** Mean PnL % across the present windows. */
  avgPnlPct: number;
  /** Total volume USD across present windows. */
  totalVolumeUsd: number;
  /** STRICT persistence = present in 24h AND 7d AND 30d. */
  strictPersistent: boolean;
  /** Lineage for ML/audit (Observation/Feature/Inference). */
  lineage: { observations: number; feature: string; inference: string };
}

const STRICT: PnlWindow[] = ['24h', '7d', '30d'];
const WINDOW_RANK: Record<PnlWindow, number> = { '24h': 0, '7d': 1, '30d': 2, all: 3 };

export class TraderPersistence {
  /** handle → window → weighted row (keeps the newest/richest per window). */
  private rows = new Map<string, Map<string, TraderWindowRow>>();
  private observations = 0;

  /** Ingest one leaderboard observation for a window. */
  public ingest(row: TraderWindowRow): void {
    const byWindow = this.rows.get(row.handle) ?? new Map<string, TraderWindowRow>();
    const key = row.window;
    const prev = byWindow.get(key);
    // Keep the observation with the larger volume (richer) or the newer one.
    if (!prev || row.volumeUsd > prev.volumeUsd) {
      byWindow.set(key, row);
      this.observations += 1;
    }
    this.rows.set(row.handle, byWindow);
  }

  /** Trader ids seen at least once. */
  public handles(): string[] {
    return [...this.rows.keys()];
  }

  /**
   * Persistent traders. With `strictOnly` (default true) only traders present
   * in ALL of 24h/7d/30d are returned — the durable leaderboard signal.
   */
  public persistentTraders(strictOnly = true): PersistentTrader[] {
    const out: PersistentTrader[] = [];
    for (const [handle, byWindow] of this.rows) {
      const present = [...byWindow.values()];
      const windowsPresent = [...present.map((r) => r.window)].sort((a, b) => WINDOW_RANK[a] - WINDOW_RANK[b]);
      const strict = STRICT.every((w) => byWindow.has(w));
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