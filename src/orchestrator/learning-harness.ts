/**
 * Q01 - Anti-overfit learning harness (SRC-236).
 * Pure, zero-dependency validation utilities that honest-check any learning
 * or calibration caller before its results are allowed to gate trading.
 */

/** Factor that shrinks toward 1 as the number of independent trials grows. */
export function deflationFactor(numTrials: number, numRuns = 1): number {
  const trials = Math.max(1, Math.floor(numTrials));
  const runs = Math.max(1, Math.floor(numRuns));
  const effective = trials * runs;
  // Deflation rises toward 1 as trial count grows: one trial is heavily
  // penalized (0), 100+ trials approach a near-neutral factor (~0.9).
  return Math.max(0, Math.min(1, 1 - 1 / Math.sqrt(effective)));
}

/**
 * Deflated Sharpe: honest Sharpe adjusted for the number of trials / search
 * effort. A single lucky backtest is penalized; many trials converge toward
 * the raw value. Returns NaN-safe clamp in a sane range.
 */
export function deflatedSharpe(
  annualizedSharpe: number,
  numTrials: number,
  numRuns = 1
): number {
  const factor = deflationFactor(numTrials, numRuns);
  const deflated = annualizedSharpe * factor;
  if (Number.isNaN(deflated)) return 0;
  // Clamp to [-10, 10] to avoid absurd inflation from a naive caller.
  return Math.max(-10, Math.min(10, deflated));
}

/**
 * Purged K-fold cross-validation. Samples within `embargo` positions of a
 * test fold are dropped from the training folds so neighboring (autocorrelated)
 * observations cannot leak into the validation.
 *
 * `foldMetric` receives the training return slice and must return a scalar
 * (e.g. mean return or a fitness value); the returned `mean` is the average
 * across folds. Degenerate inputs yield `folds: []` and `mean: NaN`.
 */
export function purgedCV(
  returns: number[],
  nSplits = 5,
  embargo = 0,
  foldMetric: (train: number[]) => number = (train) =>
    train.reduce((a, b) => a + b, 0) / (train.length || 1)
): { mean: number; folds: number[] } {
  const data = Array.isArray(returns) ? returns : [];
  const n = data.length;
  const splits = Math.max(2, Math.floor(nSplits));
  const gap = Math.max(0, Math.floor(embargo));
  if (n < splits) return { mean: Number.NaN, folds: [] };

  const folds: number[] = [];
  const foldSize = n / splits;
  for (let i = 0; i < splits; i++) {
    const testStart = Math.floor(i * foldSize);
    const testEnd = i === splits - 1 ? n : Math.floor((i + 1) * foldSize);
    const train: number[] = [];
    for (let j = 0; j < n; j++) {
      const inTest = j >= testStart && j < testEnd;
      const inEmbargo =
        (j >= testEnd && j < testEnd + gap) ||
        (j < testStart && j >= testStart - gap);
      if (!inTest && !inEmbargo) train.push(data[j]);
    }
    if (train.length === 0) return { mean: Number.NaN, folds: [] };
    folds.push(foldMetric(train));
  }
  const mean = folds.reduce((a, b) => a + b, 0) / folds.length;
  return { mean, folds };
}

/**
 * Structural / correlation leakage detector. Flags a feature that is trivially
 * predictable from the target (zero variance, perfect collinearity, or a
 * per-label variance collapse). Returns `leaked`, a 0-1 `score`, and a detail
 * string. Fail-closed: undersized input reports `leaked: true` (cannot trust).
 */
export function leakageDetector(
  features: number[][],
  target: number[]
): { leaked: boolean; score: number; detail: string } {
  const rows = Array.isArray(features) ? features : [];
  const t = Array.isArray(target) ? target : [];
  const n = rows.length;
  if (n === 0 || t.length !== n) {
    return { leaked: true, score: 1, detail: 'undersized or mismatched input' };
  }

  const colCount = Math.max(1, rows[0]?.length ?? 1);
  let worstScore = 0;
  let worstCol = -1;

  for (let c = 0; c < colCount; c++) {
    const values = rows.map((r) => Number(r?.[c]) || 0);
    const unique = new Set(values);
    if (unique.size <= 1) {
      if (1 > worstScore) {
        worstScore = 1;
        worstCol = c;
      }
      continue;
    }
    // Per-label variance collapse: a feature that is constant within each
    // distinct target label is a strong leakage marker.
    const labels = new Set(t);
    if (labels.size > 1) {
      let maxCollapse = 0;
      for (const label of labels) {
        const group = values.filter((_, i) => t[i] === label);
        const variance = groupVariance(group);
        const collapse = variance === 0 ? 1 : 1 / (1 + variance);
        if (collapse > maxCollapse) maxCollapse = collapse;
      }
      if (maxCollapse > worstScore) {
        worstScore = maxCollapse;
        worstCol = c;
      }
    }
  }

  const leaked = worstScore >= 0.8;
  const detail = leaked
    ? `feature col ${worstCol} is trivially predictable from the target (score ${worstScore.toFixed(3)})`
    : `no trivial leakage detected (worst score ${worstScore.toFixed(3)})`;
  return { leaked, score: worstScore, detail };
}

function groupVariance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return (
    values.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
    (values.length - 1)
  );
}

export interface LatchedKillSwitchConfig {
  /** Load a previously-persisted engaged state. Default: false. */
  persistLoad?: () => boolean;
  /** Persist an engaged state. Default: no-op. */
  persistSave?: (v: boolean) => void;
  /** Optional auto-clear cooldown in ms. Default: never auto-clear. */
  cooldownMs?: number;
  /** Time source for cooldown checks. Default: Date.now. */
  now?: () => number;
}

export interface LatchedKillSwitch {
  trip(reason: string): void;
  reset(): void;
  isEngaged(): boolean;
  reason(): string | null;
}

/**
 * Latched kill-switch that stays engaged across a simulated restart when a
 * `persistLoad` / `persistSave` pair is provided. Without persistence it is a
 * plain in-memory switch. Cooldown only clears engagement when explicitly
 * configured (default is fail-closed: requires reset).
 */
export function latchedKillSwitch(
  config: LatchedKillSwitchConfig = {}
): LatchedKillSwitch {
  const load = config.persistLoad ?? (() => false);
  const save = config.persistSave ?? (() => {});
  const now = config.now ?? (() => Date.now());
  let engaged = load();
  let tripReason: string | null = null;
  let trippedAt: number | null = null;

  return {
    trip(reason: string): void {
      engaged = true;
      tripReason = reason;
      trippedAt = now();
      save(true);
    },
    reset(): void {
      engaged = false;
      tripReason = null;
      trippedAt = null;
      save(false);
    },
    isEngaged(): boolean {
      if (config.cooldownMs === undefined || config.cooldownMs <= 0) {
        return engaged;
      }
      if (!engaged || trippedAt === null) return engaged;
      if (now() - trippedAt >= config.cooldownMs) {
        // Auto-clear only the in-memory state; never persist an auto-clear
        // without an explicit reset (keeps fail-closed on restart).
        engaged = false;
        tripReason = null;
      }
      return engaged;
    },
    reason(): string | null {
      return this.isEngaged() ? tripReason : null;
    },
  };
}

export interface TCAResult {
  basisBps: number;
  implementationShortfallBps: number;
}

/**
 * Transaction Cost Analysis. For a buy, a fill above the mid is adverse
 * (negative basis); for a sell, a fill below the mid is adverse. `quantity`
 * scales the shortfall. A missing quantity returns a quantity-neutral IS.
 */
export function tca(
  fillPrice: number,
  midPrice: number,
  side: 'buy' | 'sell',
  quantity?: number
): TCAResult {
  const mid = Number(midPrice);
  const fill = Number(fillPrice);
  if (!Number.isFinite(mid) || !Number.isFinite(fill) || mid === 0) {
    return { basisBps: 0, implementationShortfallBps: 0 };
  }
  const rawBasis =
    side === 'buy' ? (fill - mid) / mid : (mid - fill) / mid;
  const basisBps = rawBasis * 10000;
  const qty = Number.isFinite(quantity) && (quantity as number) > 0 ? (quantity as number) : 1;
  return {
    basisBps,
    implementationShortfallBps: basisBps * qty,
  };
}

export interface BacktestTrade {
  entryPrice: number;
  exitPrice: number;
  peakPrice?: number;
  qty: number;
  feesUsd?: number;
  slippageUsd?: number;
}

/**
 * Peak Capture Ratio: fraction of the trade's peak (favorable excursion) that
 * the exit actually captured. Null when no trade has a peak above entry, so a
 * caller never mistakes "no data" for "perfect capture".
 */
export function peakCaptureRatio(trades: BacktestTrade[]): number | null {
  const list = Array.isArray(trades) ? trades : [];
  let numerator = 0;
  let denominator = 0;
  for (const t of list) {
    const peak = t.peakPrice;
    if (!Number.isFinite(peak) || (peak as number) <= t.entryPrice) continue;
    const exitPnl = (t.exitPrice - t.entryPrice) * t.qty;
    const peakPnl = ((peak as number) - t.entryPrice) * t.qty;
    numerator += exitPnl;
    denominator += peakPnl;
  }
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export interface GrossNetSplit {
  grossPnlUsd: number;
  netPnlUsd: number;
  ratioPct: number | null;
}

/**
 * Gross vs net deterministic split (agent-arena math port): net subtracts fees
 * and slippage from gross. ratioPct is net/gross, null when gross is zero.
 */
export function grossNetSplit(trades: BacktestTrade[]): GrossNetSplit {
  const list = Array.isArray(trades) ? trades : [];
  let gross = 0;
  let fees = 0;
  let slippage = 0;
  for (const t of list) {
    gross += (t.exitPrice - t.entryPrice) * t.qty;
    fees += Number.isFinite(t.feesUsd) ? (t.feesUsd as number) : 0;
    slippage += Number.isFinite(t.slippageUsd) ? (t.slippageUsd as number) : 0;
  }
  const net = gross - fees - slippage;
  return {
    grossPnlUsd: gross,
    netPnlUsd: net,
    ratioPct: Math.abs(gross) > 1e-12 ? (net / gross) * 100 : null,
  };
}

/** Largest peak-to-trough drawdown in percent of the running peak. */
export function maxDrawdownPct(equityCurve: number[]): number {
  const curve = Array.isArray(equityCurve) ? equityCurve : [];
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of curve) {
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - v) / peak);
  }
  return maxDd * 100;
}

export interface OverfitVerdict {
  ratio: number;
  verdict: 'ROBUST' | 'WEAK' | 'OVERFITTED';
  detail: string;
}

/**
 * Walk-forward overfitting verdict (PR8.a, SRC-058). Compares out-of-sample
 * Sharpe against in-sample. Fail-closed: a non-positive in-sample Sharpe means
 * the edge is not robust, so the result is OVERFITTED.
 */
export function walkForwardVerdict(
  inSampleSharpe: number,
  outOfSampleSharpe: number
): OverfitVerdict {
  const is = Number(inSampleSharpe);
  const oos = Number(outOfSampleSharpe);
  if (!Number.isFinite(is) || !Number.isFinite(oos) || is <= 0) {
    return {
      ratio: Number.NaN,
      verdict: 'OVERFITTED',
      detail: 'in-sample Sharpe is non-positive; edge cannot be proven',
    };
  }
  const ratio = oos / is;
  const verdict =
    ratio >= 0.8 ? 'ROBUST' : ratio >= 0.2 ? 'WEAK' : 'OVERFITTED';
  return {
    ratio,
    verdict,
    detail: `OOS/IS Sharpe ratio ${ratio.toFixed(3)} -> ${verdict}`,
  };
}

export interface BacktestMetricsInput {
  candidateId?: string;
  strategyId?: string;
  trades: BacktestTrade[];
  equityCurve?: number[];
  inSampleSharpe?: number;
  outOfSampleSharpe?: number;
}

export interface BacktestMetrics {
  candidateId?: string;
  strategyId?: string;
  grossPnlUsd: number;
  netPnlUsd: number;
  ratioPct: number | null;
  peakCaptureRatio: number | null;
  maxDrawdownPct: number;
  overfitVerdict: OverfitVerdict['verdict'];
}

/**
 * Assemble per-candidate/strategy backtest metrics: gross-net split, peak
 * capture, drawdown, and the walk-forward overfitting verdict.
 */
export function computeBacktestMetrics(
  input: BacktestMetricsInput
): BacktestMetrics {
  const split = grossNetSplit(input.trades);
  const verdict = walkForwardVerdict(
    input.inSampleSharpe ?? Number.NaN,
    input.outOfSampleSharpe ?? Number.NaN
  );
  return {
    candidateId: input.candidateId,
    strategyId: input.strategyId,
    grossPnlUsd: split.grossPnlUsd,
    netPnlUsd: split.netPnlUsd,
    ratioPct: split.ratioPct,
    peakCaptureRatio: peakCaptureRatio(input.trades),
    maxDrawdownPct: maxDrawdownPct(input.equityCurve ?? []),
    overfitVerdict: verdict.verdict,
  };
}

/** Per-period Sharpe of a return series (mean / sample std), 0 for degenerate. */
export function sharpeRatio(returns: number[]): number {
  const list = Array.isArray(returns) ? returns.filter((v) => Number.isFinite(v)) : [];
  if (list.length < 2) return 0;
  const mean = list.reduce((a, b) => a + b, 0) / list.length;
  const variance = list.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (list.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return mean / std;
}

export interface WalkForwardFold {
  /** Sharpe over the training (earlier) window. */
  inSampleSharpe: number;
  /** Sharpe over the immediately-following validation window (no look-ahead). */
  outOfSampleSharpe: number;
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  meanInSampleSharpe: number;
  meanOutOfSampleSharpe: number;
  /** mean OOS / mean IS ratio; NaN when the edge cannot be proven. */
  ratio: number;
  verdict: OverfitVerdict['verdict'];
}

/**
 * PR12.a (SRC-058 tradingview-mcp): expanding-window walk-forward split.
 * The input `returns` is assumed chronological; each fold trains on the
 * strictly-earlier window and validates on the immediately-following block so
 * the out-of-sample fold never leaks training data. Fail-closed: fewer than two
 * validation blocks (or a non-positive in-sample edge) report OVERFITTED.
 */
export function walkForwardFolds(returns: number[], folds = 5): WalkForwardResult {
  const data = Array.isArray(returns) ? returns.filter((v) => Number.isFinite(v)) : [];
  const blockCount = Math.max(2, Math.floor(folds));
  const n = data.length;
  const block = Math.floor(n / blockCount);
  if (n < 2 || block < 1) {
    return {
      folds: [],
      meanInSampleSharpe: 0,
      meanOutOfSampleSharpe: 0,
      ratio: Number.NaN,
      verdict: 'OVERFITTED',
    };
  }

  const foldResults: WalkForwardFold[] = [];
  // Walk-forward chaining: fold i trains on blocks [0..i], validates on block i+1.
  for (let i = 1; i < blockCount && (i + 1) * block <= n; i++) {
    const train = data.slice(0, i * block);
    const validation = data.slice(i * block, (i + 1) * block);
    foldResults.push({
      inSampleSharpe: sharpeRatio(train),
      outOfSampleSharpe: sharpeRatio(validation),
    });
  }
  if (foldResults.length === 0) {
    return {
      folds: [],
      meanInSampleSharpe: 0,
      meanOutOfSampleSharpe: 0,
      ratio: Number.NaN,
      verdict: 'OVERFITTED',
    };
  }

  const meanIS =
    foldResults.reduce((a, b) => a + b.inSampleSharpe, 0) / foldResults.length;
  const meanOOS =
    foldResults.reduce((a, b) => a + b.outOfSampleSharpe, 0) / foldResults.length;
  const verdict = walkForwardVerdict(meanIS, meanOOS);
  return {
    folds: foldResults,
    meanInSampleSharpe: meanIS,
    meanOutOfSampleSharpe: meanOOS,
    ratio: verdict.ratio,
    verdict: verdict.verdict,
  };
}
