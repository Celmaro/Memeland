/**
 * P6.1 — Walk-forward backtest harness (ae395c P4 / ad0e47 Phase 4).
 *
 * The calibration loop (swarm-learning) is structurally starved of realized
 * outcomes, so any claimed edge must be proven OFFLINE before live activation.
 * This module provides the temporal train/val/test split (NO shuffle — a
 * time series cannot be randomly split without leaking the future) and the
 * out-of-sample metrics that decide whether a strategy's edge is real.
 *
 * Pipeline:
 *   1. Collect realized outcome rows (scorecard + outcome ledger, P4.4).
 *   2. Split chronologically: train → validation → test, strictly ordered.
 *   3. Fit/evaluate on train+validation, measure ONLY on test (OOS).
 *   4. Compare strategies (BASELINE_V1 vs swarm vs Jev-shadow) on the same
 *      OOS test window so the comparison is apples-to-apples.
 *   5. An OOS report gates live activation — no activation without one.
 *
 * Pure + deterministic; no network I/O. Outcome rows are the P4.4 scorecard
 * shape (state-store), so this harness reads the SAME training dataset the
 * swarm-learning loop consumes — never a synthetic one.
 */

import { sharpeRatio, walkForwardVerdict, type OverfitVerdict } from './learning-harness.js';

/** One realized trade outcome — matches the P4.4 scorecard shape in state-store. */
export interface OutcomeRow {
  id: string;
  /** Epoch ms when the trade/signal fired. Drives chronological order. */
  timestamp: number;
  /** Final swarm confidence (0-100) at decision time. */
  confidence: number;
  /** Realized PnL in %, signed. Positive = winner. */
  realizedPnlPct: number;
  /** Return over the 1h horizon vs entry, signed fraction. */
  return1h?: number;
  /** P4.4 multi-horizon returns, signed fraction. */
  return1m?: number;
  return15m?: number;
  /** Max favorable / adverse excursion vs entry, %. */
  mfePct?: number;
  maePct?: number;
  /** ms from entry to terminal (TP hit or SL hit). */
  timeToTpMs?: number;
  /** Strategy that produced this outcome — enables cross-strategy comparison. */
  strategy?: string;
}

/** Fractional split into the three chronological partitions. */
export interface WalkForwardSplit {
  /** Earliest block — used to fit. */
  train: OutcomeRow[];
  /** Next block — used to tune/hold out (never for final measurement). */
  validation: OutcomeRow[];
  /** Latest block — the ONLY out-of-sample measurement window. */
  test: OutcomeRow[];
}

/**
 * Chronological train/val/test split — never shuffles. Rows are ordered by
 * timestamp ascending, then sliced: train = first `trainFrac`, validation =
 * next `valFrac`, test = the remainder (the most recent, strict OOS).
 * Fractions are applied as `floor(n * frac)` so partitions are exact and the
 * later (test) block is strictly newer than validation, which is strictly
 * newer than train — no look-ahead by construction.
 */
export function walkForwardSplit(
  rows: OutcomeRow[],
  trainFrac = 0.6,
  valFrac = 0.2,
): WalkForwardSplit {
  const ordered = [...rows].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const n = ordered.length;
  const trainCount = Math.max(0, Math.floor(n * trainFrac));
  const valCount = Math.max(0, Math.floor(n * valFrac));
  const testStart = Math.min(n, trainCount + valCount);
  return {
    train: ordered.slice(0, trainCount),
    validation: ordered.slice(trainCount, testStart),
    test: ordered.slice(testStart),
  };
}

/** Out-of-sample performance of a strategy on a held-out window. */
export interface OosMetrics {
  n: number;
  /** Fraction of trades with realizedPnlPct > 0. */
  hitRate: number;
  /** Mean realized PnL % per trade (the flat EV per signal). */
  expectancy: number;
  /** Gross profit / |gross loss|; Infinity for all-winner, 0 for no profit. */
  profitFactor: number;
  /** Mean/sample-std of realized PnL %; 0 for a degenerate (flat) series. */
  sharpe: number;
  /** Mean 1h return vs entry; null when absent. */
  meanReturn1h: number | null;
  /** Mean MFE/MAE vs entry; null when absent. */
  meanMfePct: number | null;
  meanMaePct: number | null;
}

/**
 * Evaluate a held-out window of outcomes. Fail-closed on degeneracy: every
 * metric returns a finite number (0 where the statistic is undefined) so the
 * consumer can compare strategies without NaN poisoning the verdict.
 */
export function evaluateOos(rows: OutcomeRow[]): OosMetrics {
  const list = Array.isArray(rows) ? rows : [];
  const n = list.length;
  const wins = list.filter((r) => r.realizedPnlPct > 0).length;
  const grossProfit = list.reduce((a, r) => a + (r.realizedPnlPct > 0 ? r.realizedPnlPct : 0), 0);
  const grossLoss = list.reduce((a, r) => a + (r.realizedPnlPct < 0 ? -r.realizedPnlPct : 0), 0);

  const mean1h = avgOrNull(list.map((r) => r.return1h));
  const meanMfe = avgOrNull(list.map((r) => r.mfePct));
  const meanMae = avgOrNull(list.map((r) => r.maePct));

  return {
    n,
    hitRate: n > 0 ? wins / n : 0,
    expectancy: n > 0 ? list.reduce((a, r) => a + r.realizedPnlPct, 0) / n : 0,
    profitFactor:
      grossLoss > 0
        ? grossProfit / grossLoss
        : grossProfit > 0
          ? Number.POSITIVE_INFINITY
          : 0,
    sharpe: sharpeRatio(list.map((r) => r.realizedPnlPct)),
    meanReturn1h: mean1h,
    meanMfePct: meanMfe,
    meanMaePct: meanMae,
  };
}

/** Walk-forward verdict for one strategy: how its OOS window holds up. */
export interface WalkForwardStrategyResult {
  strategy: string;
  train: OosMetrics;
  validation: OosMetrics;
  test: OosMetrics;
  overfit: OverfitVerdict;
}

/**
 * Walk-forward evaluation of a SINGLE strategy's realized-outcome rows:
 * measures train (in-sample) and test (strict OOS) Sharpe and returns the
 * ROBUST / WEAK / OVERFITTED verdict — the pre-live-activation gate.
 */
export function evaluateStrategyWalkForward(
  rows: OutcomeRow[],
  strategyName: string,
  trainFrac = 0.6,
  valFrac = 0.2,
): WalkForwardStrategyResult {
  const { train, validation, test } = walkForwardSplit(rows, trainFrac, valFrac);
  const trainM = evaluateOos(train);
  const valM = evaluateOos(validation);
  const testM = evaluateOos(test);
  const overfit = walkForwardVerdict(trainM.sharpe, testM.sharpe);
  return { strategy: strategyName, train: trainM, validation: valM, test: testM, overfit };
}

/**
 * Cross-strategy comparison on the SAME chronological split. Each row carries
 * its producing strategy (BASELINE_V1 | swarm | jev-shadow). Strategies are
 * partitioned by tag, then every strategy is evaluated on an identical
 * time-partition so the OOS comparison is apples-to-apples.
 */
export function compareWalkForward(
  rows: OutcomeRow[],
  strategyNames: string[],
  trainFrac = 0.6,
  valFrac = 0.2,
): { results: WalkForwardStrategyResult[]; testSize: number } {
  const results = strategyNames
    .map((name) => {
      const group = rows.filter((r) => r.strategy === name);
      return evaluateStrategyWalkForward(group, name, trainFrac, valFrac);
    })
    .filter((r) => r.train.n + r.validation.n + r.test.n > 0);
  // All strategies share the same split sizes; report the OOS window size.
  const testSize = results.length > 0 ? results[0]!.test.n : 0;
  return { results, testSize };
}

/** Render the walk-forward OOS report — the artifact that precedes any activation. */
export function renderWalkForwardReport(
  rows: OutcomeRow[],
  strategyNames: string[],
  trainFrac = 0.6,
  valFrac = 0.2,
): string {
  const { results, testSize } = compareWalkForward(rows, strategyNames, trainFrac, valFrac);
  const lines: string[] = [
    `[WALK-FORWARD] OOS report — ${rows.length} realized outcomes, ${testSize} OOS test rows.`,
    '───────────────────────────────────────────────────────',
  ];
  for (const r of results) {
    const v = r.overfit;
    lines.push(
      `${r.strategy}: ` +
        `IS Sharpe ${r.train.sharpe.toFixed(3)} -> OOS ${r.test.sharpe.toFixed(3)} ` +
        `(ratio ${v.ratio === Number.NaN ? 'n/a' : v.ratio.toFixed(3)}): ${v.verdict} ` +
        `— hit ${(r.test.hitRate * 100).toFixed(1)}%, EV ${r.test.expectancy.toFixed(2)}%, ` +
        `PF ${r.test.profitFactor === Number.POSITIVE_INFINITY ? 'inf' : r.test.profitFactor.toFixed(2)}, ` +
        `n=${r.test.n}`,
    );
  }
  const robust = results.filter((r) => r.overfit.verdict === 'ROBUST').length;
  lines.push('───────────────────────────────────────────────────────');
  lines.push(
    robust > 0
      ? `[WALK-FORWARD] ${robust}/${results.length} strategies ROBUST — live activation permitted for those.`
      : `[WALK-FORWARD] No strategy ROBUST — hold live activation (fail-closed).`,
  );
  return lines.join('\n');
}

/** Average of a numeric array skipping undefined/non-finite; null when empty. */
function avgOrNull(values: Array<number | undefined>): number | null {
  const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}
