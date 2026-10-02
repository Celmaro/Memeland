/**
 * T1 — In-memory zero-alloc JEV/ML fast scorer.
 *
 * A bounded, <5ms CPU prediction gate over a fixed 5-feature vector. Unlike the
 * shadow-mode external JEV router (fail-closed, never gates), this is a purely
 * in-memory logistic scorer intended as an OPTIONAL, fail-open final gate before
 * dispatch. It is explicitly NOT a replacement for JEV's role (JEV stays
 * shadow-mode), and it never moves funds by itself — it only emits a
 * `{ score, pass }` verdict a caller may consult.
 *
 * Zero-allocation contract: the feature/weight vectors are module-level
 * Float64Arrays reused in place, so inference allocates no intermediate objects
 * (no GC pauses). Because the buffer is shared, `evaluateCandidateFast` is
 * single-threaded / non-reentrant (no `await` inside) — callers must not interleave.
 */

/** Fixed feature weight vector — [liqVelocity, OFI, SMP, top10Conc, DSI]. */
const WEIGHT_VECTOR = new Float64Array([0.25, 0.3, 0.2, -0.4, 0.35]);
const BIAS = -0.15;
/** Feature vector reused in place for scoring. */
const FEATURE_VECTOR = new Float64Array(5);

/** Small epsilon to avoid divide-by-zero in normalization. */
export const EPS = 1e-9;

/**
 * Liquidity velocity: (current - 5m_ago) / (5m_ago + eps). Detects sudden
 * liquidity additions (+) or stealth drain (−).
 */
export function liquidityVelocity(currentLiqUsd: number, fiveMinAgoUsd: number): number {
  return (currentLiqUsd - fiveMinAgoUsd) / (fiveMinAgoUsd + EPS);
}

/** Order-flow imbalance: (buy − sell)/(buy + sell + eps). Near +1 = one-sided buys. */
export function orderFlowImbalance(buyVolUsd: number, sellVolUsd: number): number {
  return (buyVolUsd - sellVolUsd) / (buyVolUsd + sellVolUsd + EPS);
}

/** Smart-money penetration: min(1, N/5), saturated at 5 verified smart wallets. */
export function smartMoneyPenetration(numSmartWallets: number): number {
  return Math.min(1.0, Math.max(0, numSmartWallets) / 5.0);
}

/** Holder-concentration approximation: top-10 supply / total supply. */
export function top10Concentration(top10Supply: number, totalSupply: number): number {
  return totalSupply > 0 ? top10Supply / totalSupply : 0;
}

/** Deployer survival index: 1 − numRugs/(numLaunches + 1). 1 = clean history. */
export function deployerSurvivalIndex(numHistoricalRugs: number, numTotalLaunches: number): number {
  return 1.0 - numHistoricalRugs / (numTotalLaunches + 1);
}

/**
 * Core zero-allocation inference: populates the shared Float64Array and returns
 * the sigmoid(weight·x + bias) in [0,1]. Higher = more likely a quality entry.
 */
export function evaluateCandidateFast(
  liqVelocity: number,
  orderFlowImbalanceVal: number,
  smartMoneyPenetrationVal: number,
  top10ConcentrationVal: number,
  deployerSurvivalIndexVal: number,
): number {
  FEATURE_VECTOR[0] = liqVelocity;
  FEATURE_VECTOR[1] = orderFlowImbalanceVal;
  FEATURE_VECTOR[2] = smartMoneyPenetrationVal;
  FEATURE_VECTOR[3] = top10ConcentrationVal;
  FEATURE_VECTOR[4] = deployerSurvivalIndexVal;

  let logit = BIAS;
  for (let i = 0; i < FEATURE_VECTOR.length; i += 1) {
    logit += FEATURE_VECTOR[i] * WEIGHT_VECTOR[i];
  }
  return 1 / (1 + Math.exp(-logit));
}

export interface FastScorerInput {
  currentLiqUsd: number;
  fiveMinAgoUsd: number;
  buyVol1hUsd: number;
  sellVol1hUsd: number;
  numSmartWallets: number;
  top10Supply: number;
  totalSupply: number;
  numHistoricalRugs: number;
  numTotalLaunches: number;
}

export interface FastScoreResult {
  score: number;
  passed: boolean;
  /** Which feature, if any, trips a hard penalty (concentration / rug history). */
  flagged?: string;
}

/** Default dispatch threshold — arbitrary, operator-tuned via opts. */
export const DEFAULT_SCORE_THRESHOLD = 0.5;
/** Concentration above which the scorer penalizes hard. */
export const DEFAULT_CONCENTRATION_CAP = 0.35;

/**
 * Convenience scorer: normalizes a hydration snapshot, scores it zero-allocation,
 * and returns a pass/fail verdict against `threshold`. Fail-open by construction:
 * a missing/odd input still yields a deterministic score (eps-guarded), never a
 * throw.
 */
export function scoreCandidate(
  input: FastScorerInput,
  opts: { threshold?: number; concentrationCap?: number } = {},
): FastScoreResult {
  const threshold = opts.threshold ?? DEFAULT_SCORE_THRESHOLD;
  const concentrationCap = opts.concentrationCap ?? DEFAULT_CONCENTRATION_CAP;
  const lv = liquidityVelocity(input.currentLiqUsd, input.fiveMinAgoUsd);
  const ofi = orderFlowImbalance(input.buyVol1hUsd, input.sellVol1hUsd);
  const smp = smartMoneyPenetration(input.numSmartWallets);
  const conc = top10Concentration(input.top10Supply, input.totalSupply);
  const dsi = deployerSurvivalIndex(input.numHistoricalRugs, input.numTotalLaunches);

  const score = evaluateCandidateFast(lv, ofi, smp, conc, dsi);
  // Concentration penalizes the score; a grossly concentrated or rug-heavy
  // history flags the gate regardless of raw score.
  let flagged: string | undefined;
  if (conc > concentrationCap) flagged = `top10 concentration ${conc.toFixed(3)} > ${concentrationCap}`;
  else if (dsi < 0.5) flagged = `deployer survival ${dsi.toFixed(3)} < 0.5`;

  return { score, passed: score >= threshold && !flagged, flagged };
}
