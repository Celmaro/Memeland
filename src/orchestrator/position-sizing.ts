/**
 * Q07 - Multi-constraint sizing + layered fail-closed risk gate
 * (SRC-190 COPUMP layered gate, SRC-189 daily-loss halt/cooldown).
 * Pure, zero-dep, chain-agnostic. `sizePosition` collapses to the most
 * restrictive constraint and refuses below the floor; `RuleGate` fails
 * closed on any non-OK rule so UNKNOWN never auto-approves.
 */

import { volTargetSize } from '../services/garch-vol.js';
import type { DecisionCache } from '../services/decision-cache.js';
import { confidenceToFraction } from '../services/confidence.js';

export interface SizeConstraints {
  /** Hard notional ceiling for a single entry (RH default $2,000). */
  maxNotionalUsd?: number;
  /** Per-position absolute ceiling. */
  maxUsd?: number;
  /** Refuse any sized amount below this floor. */
  minUsd?: number;
  /** Remaining daily-loss headroom; <=0 halts sizing for the window. */
  dailyLossHeadroomUsd?: number;
}

export interface SizeResult {
  /** The final size, or 0 when refused. */
  sizeUsd: number;
  /** True when sizing is refused (below floor / daily-loss halt / non-positive). */
  refused: boolean;
  /** Name of the constraint that bound the size (for the smallest upper bound). */
  constraint: string;
  reason?: string;
}

const RH_DEFAULT_MAX_NOTIONAL_USD = 2000;

export function sizePosition(desiredUsd: number, c: SizeConstraints = {}): SizeResult {
  if (!Number.isFinite(desiredUsd) || desiredUsd <= 0) {
    return { sizeUsd: 0, refused: true, constraint: 'desired', reason: 'non-positive desired size' };
  }
  if (typeof c.dailyLossHeadroomUsd === 'number' && c.dailyLossHeadroomUsd <= 0) {
    return { sizeUsd: 0, refused: true, constraint: 'dailyLossHeadroom', reason: 'daily-loss halt — sizing suppressed' };
  }

  const bounds: Array<{ name: string; value: number | undefined }> = [
    { name: 'maxNotional', value: c.maxNotionalUsd ?? RH_DEFAULT_MAX_NOTIONAL_USD },
    { name: 'maxUsd', value: c.maxUsd },
    { name: 'dailyLossHeadroom', value: c.dailyLossHeadroomUsd },
  ];
  const active = bounds.filter((b) => typeof b.value === 'number' && Number.isFinite(b.value));
  const binding = active.reduce<{ name: string; value: number } | null>(
    (acc, b) => (acc === null || (b.value as number) < acc.value ? { name: b.name, value: b.value as number } : acc),
    null
  );

  let size = desiredUsd;
  if (binding) {
    size = Math.min(size, binding.value);
  }
  const constraint = binding ? binding.name : 'none';

  if (typeof c.minUsd === 'number' && size < c.minUsd) {
    return { sizeUsd: 0, refused: true, constraint: 'minFloor', reason: `below floor $${c.minUsd}` };
  }
  return { sizeUsd: Math.max(0, Math.round(size)), refused: false, constraint };
}

/**
 * Fractional Kelly: returns the fraction of bankroll to commit, capped to the
 * requested fraction of the full Kelly edge and clamped to [0, 1]. Invalid or
 * negative-edge inputs never invent risk (0).
 */
export function fractionalKelly(winProbability: number, winLossRatio: number, fraction = 0.25): number {
  if (!Number.isFinite(winProbability) || !Number.isFinite(winLossRatio) || !Number.isFinite(fraction)) return 0;
  if (winProbability < 0 || winProbability > 1 || winLossRatio <= 0 || fraction < 0 || fraction > 1) return 0;
  const fullKelly = winProbability - (1 - winProbability) / winLossRatio;
  return Math.max(0, Math.min(1, fullKelly * fraction));
}

/** USD size produced by a fractional-Kelly allocation on a bankroll. */
export function fractionalKellySize(bankrollUsd: number, winProbability: number, winLossRatio: number, fraction = 0.25): number {
  if (!Number.isFinite(bankrollUsd) || bankrollUsd <= 0) return 0;
  return Math.round(bankrollUsd * fractionalKelly(winProbability, winLossRatio, fraction));
}

/** Caps desired size to the remaining daily-loss headroom; 0 means halted. */
export function dailyLossCapSize(desiredUsd: number, maxDailyLossUsd: number, currentDailyLossUsd: number): number {
  if (!Number.isFinite(desiredUsd) || desiredUsd <= 0) return 0;
  if (!Number.isFinite(maxDailyLossUsd) || maxDailyLossUsd <= 0) return 0;
  if (!Number.isFinite(currentDailyLossUsd) || currentDailyLossUsd >= maxDailyLossUsd) return 0;
  const headroom = Math.max(0, maxDailyLossUsd - currentDailyLossUsd);
  return Math.round(Math.min(desiredUsd, headroom));
}

/** Hard notional ceiling for a single position. */
export function maxPositionCapSize(desiredUsd: number, maxPositionUsd: number): number {
  if (!Number.isFinite(desiredUsd) || desiredUsd <= 0) return 0;
  if (!Number.isFinite(maxPositionUsd) || maxPositionUsd <= 0) return 0;
  return Math.round(Math.min(desiredUsd, maxPositionUsd));
}

/** Confidence-scaled sizing: maps 0-100 confidence (or 0-1) linearly. */
export function confidenceScaledSize(baseUsd: number, confidence: number, minScale = 0.5, maxScale = 1.5): number {
  if (!Number.isFinite(baseUsd) || baseUsd <= 0) return 0;
  const normalized = confidenceToFraction(confidence);
  const floor = Math.max(0.1, Math.min(minScale, maxScale));
  const ceil = Math.max(floor, maxScale);
  return Math.round(baseUsd * (floor + (ceil - floor) * normalized));
}

function atrLevel(entryPriceUsd: number, atrUsd: number, multiplier: number, direction: 1 | -1): number {
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return 0;
  if (!Number.isFinite(atrUsd) || atrUsd < 0) return 0;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 0;
  return entryPriceUsd + direction * atrUsd * multiplier;
}

/** ATR-based stop-loss level below entry. */
export function atrStopLoss(entryPriceUsd: number, atrUsd: number, multiplier = 2): number {
  return atrLevel(entryPriceUsd, atrUsd, multiplier, -1);
}

/** ATR-based take-profit level above entry. */
export function atrTakeProfit(entryPriceUsd: number, atrUsd: number, multiplier = 3): number {
  return atrLevel(entryPriceUsd, atrUsd, multiplier, 1);
}

/**
 * Activation-threshold trailing stop. Returns a trailed stop only after the
 * high-water mark has moved at least `activationPercent` above entry;
 * otherwise it is still inactive.
 */
export function trailingStopPrice(
  entryPriceUsd: number,
  highestPriceUsd: number,
  trailingPercent: number,
  activationPercent = 50
): number | null {
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;
  if (!Number.isFinite(highestPriceUsd) || highestPriceUsd < entryPriceUsd) return null;
  if (!Number.isFinite(trailingPercent) || trailingPercent <= 0) return null;
  if (!Number.isFinite(activationPercent) || activationPercent < 0) return null;
  if (highestPriceUsd < entryPriceUsd * (1 + activationPercent / 100)) return null;
  return highestPriceUsd * (1 - trailingPercent / 100);
}

export type GateState = 'ok' | 'fail' | 'unknown';

export interface GateResult {
  state: GateState;
  reason?: string;
}

export type GateCheck = () => GateResult | Promise<GateResult>;

export interface GateRule {
  name: string;
  check: GateCheck;
}

/**
 * Fail-closed rule chain. Any rule returning something other than `ok`
 * (including `unknown`) refuses the whole chain — UNKNOWN never auto-approves.
 */
export class RuleGate {
  constructor(private readonly rules: GateRule[] = []) {}

  async evaluate(): Promise<{ allowed: boolean; refusals: string[] }> {
    const refusals: string[] = [];
    for (const rule of this.rules) {
      const r = await rule.check();
      if (r.state !== 'ok') refusals.push(r.reason ? `${rule.name}: ${r.reason}` : `${rule.name}: ${r.state}`);
    }
    return { allowed: refusals.length === 0, refusals };
  }
}

/** A cooldown/rate-halt gate: fails until `now` passes `lastActiveAt + coolMs`. */
export function cooldownGate(lastActiveAt: number | null, coolMs: number, now = Date.now()): GateCheck {
  return () => {
    if (lastActiveAt === null || now >= lastActiveAt + coolMs) return { state: 'ok' };
    const waitMs = lastActiveAt + coolMs - now;
    return { state: 'fail', reason: `cooldown ${Math.ceil(waitMs / 1000)}s remaining` };
  };
}

/**
 * PR12.f (SRC-133 autogen-financial-analysis): Value-at-Risk + Expected
 * Shortfall as a tail-risk sizing input. VaR is expressed as a positive loss
 * magnitude (a return with probability `1 - confidence` of being worse), and ES
 * is the average loss beyond that quantile. FAIL-CLOSED: an attempt to read a
 * tail-risk number from degenerate/insufficient data returns NaN, never a false
 * "safe" figure.
 */

/** Inverse standard-normal CDF (Acklam approximation), used by PARAMETRIC/MC. */
export function normalQuantile(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return Number.NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const bb = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((bb[0] * r + bb[1]) * r + bb[2]) * r + bb[3]) * r + bb[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Sample mean and sample std of a return series. */
export function returnMoments(returns: number[]): { mean: number; std: number; n: number } {
  const list = Array.isArray(returns) ? returns.filter((v) => Number.isFinite(v)) : [];
  const n = list.length;
  if (n < 2) return { mean: 0, std: 0, n };
  const mean = list.reduce((a, b) => a + b, 0) / n;
  const variance = list.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  return { mean, std: Math.sqrt(variance), n };
}

/** Historical VaR as a positive loss magnitude at the given confidence. */
export function historicalVaR(returns: number[], confidence = 0.95): number {
  const list = Array.isArray(returns) ? returns.filter((v) => Number.isFinite(v)) : [];
  if (list.length === 0 || !Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) return Number.NaN;
  const sorted = [...list].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((1 - confidence) * sorted.length)));
  return -sorted[idx];
}

/** Expected shortfall beyond the historical VaR quantile. */
export function expectedShortfall(returns: number[], confidence = 0.95): number {
  const list = Array.isArray(returns) ? returns.filter((v) => Number.isFinite(v)) : [];
  if (list.length === 0 || !Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) return Number.NaN;
  const sorted = [...list].sort((a, b) => a - b);
  const nTail = Math.max(1, Math.ceil((1 - confidence) * sorted.length));
  const tail = sorted.slice(0, nTail);
  return -tail.reduce((a, b) => a + b, 0) / tail.length;
}

/** PARAMETRIC VaR/ES under a normal assumption. */
export function parametricVarEs(
  mean: number,
  std: number,
  confidence = 0.95,
): { var: number; es: number } {
  if (
    !Number.isFinite(mean) ||
    !Number.isFinite(std) ||
    std <= 0 ||
    !Number.isFinite(confidence) ||
    confidence <= 0 ||
    confidence >= 1
  ) {
    return { var: Number.NaN, es: Number.NaN };
  }
  const z = normalQuantile(confidence);
  const varLoss = z * std - mean;
  // ES under normality = mean - std * phi(z) / (1 - confidence); phi(z) is the standard normal PDF.
  const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const esLoss = mean - (std * phi) / (1 - confidence);
  return { var: Math.max(0, varLoss), es: Math.max(0, esLoss) };
}

export type VarMethod = 'HISTORICAL' | 'PARAMETRIC' | 'MONTE_CARLO';

export interface RiskMetricResult {
  varPct: number;
  esPct: number;
  method: VarMethod;
  confidence: number;
}

/** Deterministic seedable LCG so Monte-Carlo VaR is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Monte-Carlo VaR/ES: samples `nSims` normals from the input series moments.
 * Returns NaN for degenerate input; otherwise never throws and is seed-deterministic.
 */
export function monteCarloVarEs(
  returns: number[],
  confidence = 0.95,
  nSims = 1000,
  seed = 42,
): { var: number; es: number } {
  const { mean, std, n } = returnMoments(returns);
  if (n < 2 || std <= 0 || !Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    return { var: Number.NaN, es: Number.NaN };
  }
  const sims: number[] = [];
  const rng = mulberry32(Math.floor(seed));
  for (let i = 0; i < Math.max(2, Math.floor(nSims)); i++) {
    const u = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, rng()));
    sims.push(mean + std * normalQuantile(u));
  }
  return { var: historicalVaR(sims, confidence), es: expectedShortfall(sims, confidence) };
}

/** Dispatch a tail-risk read by method; NaN propagates from any degenerate input. */
export function riskMetrics(
  returns: number[],
  confidence = 0.95,
  method: VarMethod = 'HISTORICAL',
): RiskMetricResult {
  const { mean, std } = returnMoments(returns);
  let v = Number.NaN;
  let e = Number.NaN;
  if (method === 'PARAMETRIC') {
    const p = parametricVarEs(mean, std, confidence);
    v = p.var;
    e = p.es;
  } else if (method === 'MONTE_CARLO') {
    const m = monteCarloVarEs(returns, confidence);
    v = m.var;
    e = m.es;
  } else {
    v = historicalVaR(returns, confidence);
    e = expectedShortfall(returns, confidence);
  }
  return { varPct: v, esPct: e, method, confidence };
}

export type RiskBucket = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Bucket a VaR percentage into a severity tier (autogen threshold-bucket pattern). */
export function riskBucket(varPct: number): RiskBucket {
  if (!Number.isFinite(varPct) || varPct < 0) return 'CRITICAL';
  if (varPct < 5) return 'LOW';
  if (varPct < 10) return 'MEDIUM';
  if (varPct < 20) return 'HIGH';
  return 'CRITICAL';
}

/**
 * Cache-aware vol-target sizing (GARCH walk-forward cache). Fail-closed: when
 * no vol target can be read from the cache the notional is 0, never scaled up.
 */
export async function volTargetSizedPosition(
  cache: DecisionCache,
  token: string,
  baseUsd: number,
  targetVolPct = 20
): Promise<number> {
  const forecastVolPct = await cache.getVolTarget(token);
  return volTargetSize(baseUsd, forecastVolPct ?? 0, targetVolPct);
}
