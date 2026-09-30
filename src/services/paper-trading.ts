/**
 * P6.2 — Paper trading (Arch 5 Phase 2 path).
 *
 * DRY_RUN simulates fills, but nothing proved the edge across REGIMES before
 * approval unlock. This ledger closes that gap:
 *   - Fills at TWO-SIDED mid (best bid + best ask / 2) — fail-closed when
 *     either side is missing (copy-bot lesson: complement-side mirroring on
 *     two-sided depth only; a one-sided book is not an executable price).
 *   - Every paper fill records an OPEN journal entry tagged `paper` + regime,
 *     closed later at TP/SL → realizedPnlPct feeds the walk-forward harness
 *     (P6.1) and the regime-coverage gate.
 *   - `paperUnlockGate`: APPROVAL/AUTO stays locked until closed paper trades
 *     span ≥ minRegimes regimes (default 3) with ≥ minPerRegime trades EACH
 *     and positive overall expectancy. Fail-closed by default.
 *
 * Pure + deterministic; the only side effects are the injected journal writes.
 */

import fs from 'fs';
import path from 'path';
import type { TradeJournalService } from './trade-journal-service.js';
import { simulateFill, type PoolDepth } from './fill-simulation.js';
import type { PositionRegime } from '../position/position-manager.js';

/** Two-sided book — BOTH sides are required for a mid-market fill. */
export interface TwoSidedBook {
  bestBidUsd: number;
  bestAskUsd: number;
}

/** Mid of a two-sided book; refuses (null) when either side is missing/absent. */
export function twoSidedMid(book: TwoSidedBook | null | undefined): number | null {
  if (!book) return null;
  const bid = Number(book.bestBidUsd);
  const ask = Number(book.bestAskUsd);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  return (bid + ask) / 2;
}

/**
 * Model a two-sided book from a REAL mid + REAL depth using the same
 * constant-product splash model as the fill-sim gate (impact = notional/
 * liquidity). bid = mid×(1−i), ask = mid×(1+i) — the modeled AMM spread at the
 * intended notional. This is paper-trading ONLY: it models what a real order
 * would print against the pool, never fabricates an observed price. Fail-closed:
 * unknown/non-positive depth → null.
 */
export function bookFromMid(midUsd: number, liquidityUsd: number | undefined, notionalUsd: number): TwoSidedBook | null {
  const mid = Number(midUsd);
  const liq = Number(liquidityUsd);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  if (!Number.isFinite(liq) || liq <= 0 || !Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;
  const impact = (notionalUsd / liq); // fraction, not %
  if (impact >= 1) return null; // notional > depth — no meaningful two-sided book
  return { bestBidUsd: mid * (1 - impact), bestAskUsd: mid * (1 + impact) };
}

export interface PaperTradeInput {
  symbol: string;
  chain: string;
  contractAddress: string;
  /** Two-sided best bid/ask — the ONLY accepted entry price source. */
  book: TwoSidedBook;
  /** Real pooled liquidity (depth) for the splash fill-sim; absent → fail-closed. */
  liquidityUsd?: number;
  sizeUsd: number;
  confidence: number;
  regime?: PositionRegime | null;
  strategyUsed?: string;
  thesis?: string;
  /** Scorecard this paper trade mirrors — TP/SL flips on the scorecard close it. */
  scorecardId?: string;
}

export interface PaperTrade {
  id: string;
  symbol: string;
  chain: string;
  contractAddress: string;
  entryFillPriceUsd: number;
  slipPct: number;
  sizeUsd: number;
  confidence: number;
  regime?: PositionRegime | null;
  strategyUsed?: string;
  scorecardId?: string;
  entryTimestamp: number;
  status: 'OPEN' | 'CLOSED_TP' | 'CLOSED_SL' | 'CLOSED_MANUAL';
  exitPriceUsd?: number;
  realizedPnlPct?: number;
}

export interface OpenPaperTradeResult {
  ok: boolean;
  reason?: string;
  trade?: PaperTrade;
}

export interface PaperUnlockStatus {
  unlocked: boolean;
  /** Closed paper trades per regime. */
  coverage: Record<string, number>;
  /** Mean realized PnL % over ALL closed paper trades. */
  expectancyPct: number;
  reason: string;
}

export interface PaperUnlockGateOptions {
  /** Distinct regimes that must each clear minPerRegime (default 3). */
  minRegimes?: number;
  /** Closed paper trades required per regime (default 5). */
  minPerRegime?: number;
  /** Positive expectancy floor (%): mean realized PnL must exceed this (default 0). */
  minExpectancyPct?: number;
}

export const DEFAULT_PAPER_FILE = path.resolve('database', 'paper-trades.jsonl');

/** Durable sink for paper trades — appended on every state change (open + close). */
export interface PaperTradeIO {
  append(trade: PaperTrade): void;
}

/** Resolve the Postgres connection string for the durable paper ledger. */
function paperPostgresUrl(): string | null {
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URI ?? process.env.POSTGRES_CONNECTION_STRING ?? null;
}

/** File-backed PaperTradeIO — one JSON line per state snapshot (JSONL, last-write-wins on load). */
export function filePaperTradeIO(filePath: string = DEFAULT_PAPER_FILE): PaperTradeIO {
  return {
    append: (trade: PaperTrade) => {
      try {
        const absolutePath = path.resolve(filePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.appendFileSync(absolutePath, `${JSON.stringify(trade)}\n`, 'utf-8');
      } catch (error) {
        console.warn(`[PAPER] failed to append ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * P8 — Postgres-backed PaperTradeIO. Upserts each trade by id so the LATEST state
 * (open or closed) wins on reload. Fail-open: a paused DB never blocks a paper
 * fill. Lazy pool — no connection until the first append.
 */
export function pgPaperTradeIO(url: string = paperPostgresUrl() ?? ''): PaperTradeIO {
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
    append: (trade: PaperTrade) => {
      if (!dbUrl) return;
      void ensurePool()
        .then((p) =>
          p?.query(
            `INSERT INTO paper_trades (id, payload, updated_at) VALUES ($1, $2, $3)
             ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
            [trade.id, JSON.stringify(trade), trade.entryTimestamp],
          ),
        )
        .catch(() => { /* fail-open */ });
    },
  };
}

/**
 * P8 — Load durable paper trades as PaperTrade[]. Reads the Postgres history when a
 * URL is present, else the JSONL file. Duplicate ids collapse to their last state
 * (a trade appears once, open→closed). Used to rebuild the ledger on restart.
 */
export async function loadPaperTrades(opts?: { url?: string; file?: string }): Promise<PaperTrade[]> {
  const url = opts?.url ?? paperPostgresUrl();
  const byId = new Map<string, PaperTrade>();
  if (url) {
    try {
      const { default: Pg } = await import('pg');
      const pool = new Pg.Pool({ connectionString: url, max: 2 });
      const { rows } = await pool.query<{ payload: string }>('SELECT payload FROM paper_trades');
      await pool.end();
      for (const r of rows) {
        try { const t = JSON.parse(r.payload) as PaperTrade; byId.set(t.id, t); } catch { /* skip bad row */ }
      }
      return [...byId.values()];
    } catch (err) {
      console.warn(`[PAPER] failed to load durable trades: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  const filePath = path.resolve(opts?.file ?? DEFAULT_PAPER_FILE);
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line) as PaperTrade; byId.set(t.id, t); } catch { /* skip bad line */ }
    }
  } catch { /* no file yet */ }
  return [...byId.values()];
}

/**
 * Create a durable paper ledger: Postgres-backed (with best-effort hydration of the
 * closed-trade history the unlock gate depends on) when a DB URL is present, else
 * file/JSONL-backed with no hydration (current behavior).
 */
export function createDefaultPaperTradingLedger(journal: TradeJournalService | null): PaperTradingLedger {
  const url = paperPostgresUrl();
  const ledger = new PaperTradingLedger(journal, Date.now, url ? pgPaperTradeIO(url) : filePaperTradeIO());
  if (url) {
    void loadPaperTrades({ url })
      .then((ts) => { if (ts.length > 0) ledger.hydrate(ts); })
      .catch(() => { /* hydration is best-effort */ });
  }
  return ledger;
}

/** Paper ledger — records paper fills as journal entries and gates approval unlock. */
export class PaperTradingLedger {
  private trades = new Map<string, PaperTrade>();

  constructor(
    private readonly journal: TradeJournalService | null,
    private readonly now: () => number = Date.now,
    private readonly io?: PaperTradeIO,
  ) {}

  /** All paper trades (open + closed), in insertion order. */
  get all(): PaperTrade[] {
    return [...this.trades.values()];
  }

  /**
   * P8 — rebuild the ledger from a durable trade history after a restart. Applies
   * only when the ledger is empty this process (no live divergence), so it never
   * clobbers trades recorded in the current run.
   */
  hydrate(trades: PaperTrade[]): void {
    if (this.trades.size > 0) return;
    for (const t of trades) this.trades.set(t.id, t);
  }

  /**
   * Open a paper position: two-sided mid required, splash fill-sim against
   * real depth (fail-closed on unknown liquidity), journal OPEN entry tagged
   * `paper` + regime. Never touches a live executor.
   */
  openTrade(input: PaperTradeInput): OpenPaperTradeResult {
    const mid = twoSidedMid(input.book);
    if (mid === null) {
      return { ok: false, reason: 'no two-sided mid (one-sided or empty book) — fail-closed' };
    }
    if (typeof input.liquidityUsd !== 'number' || !Number.isFinite(input.liquidityUsd) || input.liquidityUsd <= 0) {
      return { ok: false, reason: 'unknown pool liquidity — fail-closed (no splash proof)' };
    }
    const sim = simulateFill({ notionalUsd: input.sizeUsd, midPriceUsd: mid, depth: { liquidityUsd: input.liquidityUsd } });
    if (sim.refused) return { ok: false, reason: sim.reason || 'fill-sim refused' };

    const trade: PaperTrade = {
      id: `PAPER_${this.now()}_${Math.random().toString(36).substring(2, 7)}`,
      symbol: input.symbol || 'TOKEN',
      chain: input.chain,
      contractAddress: input.contractAddress || input.symbol || '',
      entryFillPriceUsd: sim.fillPriceUsd,
      slipPct: sim.expectedSlipPct,
      sizeUsd: input.sizeUsd,
      confidence: input.confidence,
      regime: input.regime ?? null,
      strategyUsed: input.strategyUsed,
      scorecardId: input.scorecardId,
      entryTimestamp: this.now(),
      status: 'OPEN',
    };
    this.trades.set(trade.id, trade);
    this.io?.append(trade);

    try {
      this.journal?.recordTradeEntry({
        id: trade.id,
        domain: 'MEME_ROBINHOOD',
        symbol: trade.symbol,
        contractAddressOrId: trade.contractAddress,
        chain: trade.chain,
        entryTimestamp: new Date(trade.entryTimestamp).toISOString(),
        entryPriceUsdOrEth: trade.entryFillPriceUsd,
        positionSizeUsd: trade.sizeUsd,
        swarmScore: trade.confidence,
        strategyUsed: trade.strategyUsed || 'paper',
        aiThesisSummary: (input.thesis || '').slice(0, 200),
        status: 'OPEN',
        paper: true,
        regime: trade.regime ?? undefined,
      });
    } catch (err: unknown) {
      // Journal write failure must not abort the paper ledger; the trade map
      // remains the source of truth for the unlock gate.
      console.warn(`[PAPER] journal write failed for ${trade.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true, trade };
  }

  /**
   * Close a paper trade at the given exit price → realizedPnlPct vs the
   * splashed fill price (not the raw mid), status CLOSED_TP/CLOSED_SL/MANUAL.
   */
  closeTrade(id: string, exitPriceUsd: number, status: Exclude<PaperTrade['status'], 'OPEN'>): { ok: boolean; reason?: string; pnlPct?: number } {
    const t = this.trades.get(id);
    if (!t) return { ok: false, reason: `unknown paper trade ${id}` };
    if (t.status !== 'OPEN') return { ok: false, reason: `paper trade ${id} already ${t.status}` };
    const price = Number(exitPriceUsd);
    if (!Number.isFinite(price) || price <= 0) return { ok: false, reason: `invalid exit price ${exitPriceUsd}` };

    t.exitPriceUsd = price;
    t.status = status;
    t.realizedPnlPct = ((price - t.entryFillPriceUsd) / t.entryFillPriceUsd) * 100;
    this.io?.append({ ...t });

    try {
      this.journal?.closeTrade(id, price, status, `paper ${status} exit`);
    } catch (err: unknown) {
      console.warn(`[PAPER] journal close failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true, pnlPct: t.realizedPnlPct };
  }

  /** Closed paper trades per regime (only regimes with ≥ 1 closed trade appear). */
  closedByRegime(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const t of this.trades.values()) {
      if (t.status === 'OPEN') continue;
      const regime = t.regime ?? 'UNKNOWN';
      counts[regime] = (counts[regime] ?? 0) + 1;
    }
    return counts;
  }

  /** Close the OPEN paper trade mirroring a scorecard (TP/SL flip closes it). */
  closeByScorecard(scorecardId: string, exitPriceUsd: number, status: Exclude<PaperTrade['status'], 'OPEN'>): { ok: boolean; reason?: string; pnlPct?: number } {
    const match = [...this.trades.values()].find((t) => t.scorecardId === scorecardId && t.status === 'OPEN');
    if (!match) return { ok: false, reason: `no OPEN paper trade for scorecard ${scorecardId}` };
    return this.closeTrade(match.id, exitPriceUsd, status);
  }

  /**
   * Approval-unlock gate (fail-closed): APPROVAL/AUTO stays locked until closed
   * paper trades span ≥ minRegimes regimes with ≥ minPerRegime trades EACH and
   * positive overall expectancy. Any condition unmet → locked.
   */
  unlockStatus(opts: PaperUnlockGateOptions = {}): PaperUnlockStatus {
    const minRegimes = opts.minRegimes ?? 3;
    const minPerRegime = opts.minPerRegime ?? 5;
    const minExpectancyPct = opts.minExpectancyPct ?? 0;

    const coverage = this.closedByRegime();
    const closedAll = [...this.trades.values()].filter((t) => t.status !== 'OPEN').map((t) => t.realizedPnlPct ?? 0);
    const expectancyPct = closedAll.length > 0 ? closedAll.reduce((a, b) => a + b, 0) / closedAll.length : 0;

    const regimesMet = Object.values(coverage).filter((n) => n >= minPerRegime).length;
    const spanMet = regimesMet >= minRegimes;
    const expectancyMet = closedAll.length > 0 && expectancyPct > minExpectancyPct;

    if (!spanMet || !expectancyMet) {
      const reasons: string[] = [];
      if (!spanMet) reasons.push(`regimes ${regimesMet}/${minRegimes} with ≥${minPerRegime} closed trades (coverage ${JSON.stringify(coverage)})`);
      if (!expectancyMet) reasons.push(`expectancy ${expectancyPct.toFixed(2)}% over ${closedAll.length} closed paper trades`);
      return { unlocked: false, coverage, expectancyPct, reason: `PAPER GATE locked — ${reasons.join('; ')}` };
    }
    return {
      unlocked: true,
      coverage,
      expectancyPct,
      reason: `PAPER GATE unlocked (${regimesMet} regimes × ≥${minPerRegime}, expectancy ${expectancyPct.toFixed(2)}%)`,
    };
  }
}
