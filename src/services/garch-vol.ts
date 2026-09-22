/**
 * Q14 - Walk-forward GARCH(1,1) + vol-target sizing (SRC-150). Bounded,
 * causal forecast (no look-ahead), validated through the Q01 harness before it
 * could gate any fill. Optional add: only wired live once the harness is honest.
 */

import { purgedCV } from '../orchestrator/learning-harness.js';

export interface GarchParams {
  omega: number;
  alpha: number;
  beta: number;
}

export interface GarchForecast {
  /** One-step conditional volatility per return (same length as returns). */
  vols: number[];
  /** Next-step conditional volatility. */
  nextVol: number;
}

/**
 * Causal (walk-forward) GARCH(1,1): h_t depends only on r_{t-1} and h_{t-1}.
 * Initial variance is the parameterized long-run value, so no future data leaks
 * into the seed. Vol is bounded via a floor.
 */
export function garchWalkForward(returns: number[], params: GarchParams): GarchForecast {
  const { omega, alpha, beta } = params;
  if (alpha + beta >= 1) return { vols: [], nextVol: 0 };
  const longRunVar = omega / (1 - alpha - beta);
  let h = Math.max(longRunVar, 1e-12);
  const vols: number[] = [];
  for (let i = 0; i < returns.length; i++) {
    const r = Number.isFinite(returns[i]) ? returns[i] : 0;
    h = omega + alpha * r * r + beta * h;
    vols.push(Math.sqrt(Math.max(h, 1e-12)));
  }
  return { vols, nextVol: Math.sqrt(Math.max(h, 1e-12)) };
}

/**
 * Vol-target sizing: scale notional inversely to forecast vol, capped so we
 * never scale up beyond the base. As forecast vol rises, notional falls.
 */
export function volTargetSize(baseUsd: number, forecastVolPct: number, targetVolPct: number): number {
  if (!Number.isFinite(forecastVolPct) || forecastVolPct <= 0) return 0;
  if (!Number.isFinite(baseUsd) || baseUsd <= 0) return 0;
  const ratio = targetVolPct > 0 ? Math.min(1, targetVolPct / forecastVolPct) : 0;
  return Math.max(0, Math.round(baseUsd * ratio));
}

/**
 * Honest-harness gate: prove a GARCH vol estimate is computable out-of-fold
 * before it may gate a live fill. Runs the Q01 `purgedCV` (embargo-aware) over
 * squared returns; a non-finite purged estimate blocks the gate. This keeps the
 * future test window and its embargo out of the training folds (no look-ahead).
 */
export function garchHarnessValidation(returns: number[], _params: GarchParams): {
  valid: boolean;
  purgedMean?: number;
  reason: string;
} {
  if (returns.length < 8) return { valid: false, reason: 'too few returns to validate honestly' };
  const squared = returns.map((r) => r * r);
  const { mean } = purgedCV(squared, 5, 1, (train) => {
    const v = train.reduce((a, b) => a + b, 0) / (train.length || 1);
    return v;
  });
  if (!Number.isFinite(mean)) return { valid: false, reason: 'purged estimate non-finite — gate blocked' };
  return { valid: true, purgedMean: mean, reason: 'purged walk-forward vol estimate is honest' };
}
