/**
 * #5 — Calibrated decision: raw_score and calibrated_probability are DISTINCT.
 *
 * The current system conflates an additive 0-100 heuristic ("confidence") with
 * a real win probability. A 90% additive score is NOT a 90% chance of winning.
 * This keeps the two apart so consumers can act on a calibrated P(win) while
 * preserving the raw signal for diagnostics/learning.
 *
 * `calibratedProbability` is null when no calibration is available — a missing
 * probability is never fabricated into a number that looks like a real odds.
 */

export interface CalibratedDecision {
  /** Additive heuristic score, 0-100 (what the voters/strategy produce). */
  rawScore: number;
  /** Calibrated P(win | snapshot, horizon) in [0,1]. Null = not calibrated yet. */
  calibratedProbability: number | null;
  /** Decision horizon the probability is conditioned on (e.g. '15m', '1h'). */
  horizon?: string;
  /** Which calibration model produced the probability (e.g. 'arch3-platt'). */
  model?: string;
  /** Epoch ms of the decision. */
  decidedAt: number;
}

export function calibratedDecision(input: {
  rawScore: number;
  probability?: number;
  horizon?: string;
  model?: string;
}): CalibratedDecision {
  const raw = Math.max(0, Math.min(100, Math.round(input.rawScore)));
  const prob =
    typeof input.probability === 'number' && Number.isFinite(input.probability)
      ? Math.max(0, Math.min(1, input.probability))
      : null;
  return {
    rawScore: raw,
    calibratedProbability: prob,
    ...(input.horizon ? { horizon: input.horizon } : {}),
    ...(input.model ? { model: input.model } : {}),
    decidedAt: Date.now(),
  };
}
