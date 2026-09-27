/**
 * P5.1 — Persistent-trader cohort (d1326a proposal).
 *
 * The filter: `GMGN_24h ∩ GMGN_7d ∩ GMGN_30d` per source, then intersect
 * across GMGN ∩ FOMO ∩ Pump.fun → CROSS_PLATFORM_PERSISTENT. The point is to
 * distinguish persistent skill from a one-day spike: Trader A (rank 14/21/18
 * across horizons) from Trader B (1/431/892).
 *
 * Tiers: A = persistent in one source, B = two, C = three.
 * COHORT_CONVERGENCE: 3+ persistent wallets enter the SAME token within a
 * short window (5 min default) — the wallet-grounded version of GMGN's
 * smart-money feed, and the most valuable single signal in the design.
 */

export type CohortSource = 'gmgn' | 'fomo' | 'pump';

export interface LeaderboardRow {
  handle: string;
  rank24h: number;
  rank7d: number;
  rank30d: number;
  source: CohortSource;
}

interface TraderState {
  handle: string;
  sources: Set<CohortSource>;
  windows: Partial<Record<CohortSource, { present24h: boolean; present7d: boolean; present30d: boolean }>>;
}

export interface ConvergenceEvent {
  token: string;
  wallets: Array<{ handle: string; at: number }>;
  at: number;
}

const PERSISTENT_RANK = 100;

export class PersistenceCohort {
  private traders = new Map<string, TraderState>();
  /** Recent per-token wallet buys for convergence detection. */
  private tokenBuys = new Map<string, Array<{ handle: string; at: number }>>();

  /** Record a leaderboard observation. Present = rank <= 100 in that window. */
  public observe(row: LeaderboardRow): void {
    let t = this.traders.get(row.handle);
    if (!t) {
      t = { handle: row.handle, sources: new Set(), windows: {} };
      this.traders.set(row.handle, t);
    }
    t.sources.add(row.source);
    t.windows[row.source] = {
      present24h: row.rank24h <= PERSISTENT_RANK,
      present7d: row.rank7d <= PERSISTENT_RANK,
      present30d: row.rank30d <= PERSISTENT_RANK,
    };
  }

  /** Persistent within a source = present in ALL 3 windows there. */
  public persistentIn(handle: string, source: CohortSource): boolean {
    const t = this.traders.get(handle);
    const w = t?.windows[source];
    if (!w) return false;
    return w.present24h && w.present7d && w.present30d;
  }

  /** Persistent overall = present in all 3 windows in at least one source. */
  public isPersistent(handle: string): boolean {
    const t = this.traders.get(handle);
    if (!t) return false;
    for (const src of t.sources) {
      if (this.persistentIn(handle, src)) return true;
    }
    return false;
  }

  /** Tier A/B/C by cross-source persistence. */
  public tier(handle: string): 'A' | 'B' | 'C' | null {
    const t = this.traders.get(handle);
    if (!t) return null;
    let persistentSources = 0;
    for (const src of t.sources) {
      if (this.persistentIn(handle, src)) persistentSources += 1;
    }
    if (persistentSources >= 3) return 'C';
    if (persistentSources === 2) return 'B';
    if (persistentSources === 1) return 'A';
    return null;
  }

  /** Record a persistent wallet buying a token; detect convergence events. */
  public recordBuy(handle: string, token: string, at: number): void {
    if (!this.isPersistent(handle)) return;
    if (!this.tokenBuys.has(token)) this.tokenBuys.set(token, []);
    this.tokenBuys.get(token)!.push({ handle, at });
  }

  /** COHORT_CONVERGENCE: 3+ DISTINCT persistent wallets on the same token
   *  within `windowMs`. Returns the event or null. */
  public checkConvergence(
    token: string,
    buys: Array<{ handle: string; at: number }>,
    windowMs = 5 * 60 * 1000,
  ): ConvergenceEvent | null {
    const sorted = [...buys].sort((a, b) => a.at - b.at);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 2; j < sorted.length; j++) {
        if (sorted[j]!.at - sorted[i]!.at > windowMs) break;
        const window = sorted.slice(i, j + 1);
        const handles = new Set(window.map((b) => b.handle));
        if (handles.size >= 3 && window.every((b) => this.isPersistent(b.handle))) {
          return { token, wallets: window, at: window[window.length - 1]!.at };
        }
      }
    }
    return null;
  }

  public size(): number {
    return this.traders.size;
  }
}

/** Process-wide singleton. */
export const globalPersistenceCohort = new PersistenceCohort();
