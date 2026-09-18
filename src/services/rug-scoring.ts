/**
 * Rug-feature scoring (arXiv 2608.20271 — early-window rug signals).
 *
 * Folds "first N minutes" rug indicators (liquidity, holder breadth, social
 * proof) into the security voter. We cannot reconstruct historical 5-minute
 * snapshots, so we evaluate the available fields as an EARLY-WINDOW check:
 * a token still inside `freshAgeHours` of launch is judged against early-round
 * thresholds — thin liquidity, a tiny holder base, and near-zero social proof
 * together are classic rug-launch signatures and are surfaced as concrete
 * security-voter penalties.
 *
 * A token that has already survived past `freshAgeHours` gets a pass on the
 * early-window checks (survivor bias) but still logs a neutral narrative.
 * Fail-open: missing creation time or metrics never penalize.
 */

import type { GMGNRawToken } from '../adapters/gmgn-adapter.js';

export interface RugFeatureConfig {
  /** A token younger than this (hours) is inside the early-window check. */
  freshAgeHours: number;
  /** Early liquidity below this (USD) is a rug warning. */
  minEarlyLiquidityUsd: number;
  /** Early holder count below this is a rug warning. */
  minEarlyHolders: number;
  /** Early social proxy (visits + 10*mensions) below this is a rug warning. */
  minSocialScore: number;
}

export interface RugFeatureAssessment {
  tokenAgeHours: number;
  freshToken: boolean;
  /** 0-100 health inside the early window (100 = safe). Outside → 100. */
  score: number;
  /** Human-readable penalties to hand to the security voter. */
  penalties: string[];
}

const DEFAULT_CONFIG: RugFeatureConfig = {
  freshAgeHours: 0.5, // 30 minutes
  minEarlyLiquidityUsd: 25_000,
  minEarlyHolders: 200,
  minSocialScore: 15,
};

export function socialScoreOf(token: GMGNRawToken): number {
  return (token.visitingCount ?? 0) + (token.squareMentions ?? 0) * 10;
}

export class RugScoringService {
  private config: RugFeatureConfig;

  constructor(config?: Partial<RugFeatureConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public assess(token: GMGNRawToken): RugFeatureAssessment {
    const c = this.config;
    const ageHours =
      token.creationTimestamp && token.creationTimestamp > 0
        ? (Date.now() - token.creationTimestamp * 1000) / 3_600_000
        : Infinity;
    // A token we cannot date is treated as non-fresh (survivor) → not penalized.
    const freshToken = Number.isFinite(ageHours) && ageHours <= c.freshAgeHours;

    if (!freshToken) {
      return {
        tokenAgeHours: ageHours === Infinity ? -1 : ageHours,
        freshToken: false,
        score: 100,
        penalties: [],
      };
    }

    const penalties: string[] = [];
    let dings = 0;

    const liq = token.liquidityUsd ?? 0;
    if (liq > 0 && liq < c.minEarlyLiquidityUsd) {
      penalties.push(`thin early liquidity $${(liq / 1000).toFixed(1)}k (<$${c.minEarlyLiquidityUsd / 1000}k)`);
      dings += 1;
    }

    const holders = token.holderCount ?? 0;
    if (holders > 0 && holders < c.minEarlyHolders) {
      penalties.push(`early holders ${holders} (<${c.minEarlyHolders})`);
      dings += 1;
    }

    // For early-window social proof, absence is itself a signal: a real fresh
    // launch with no visits/mentions and thin liquidity+holders is a rug shape.
    const social = socialScoreOf(token);
    if (social < c.minSocialScore) {
      penalties.push(`near-zero social proof (score ${social})`);
      dings += 1;
    }

    // 100 - 25 per early-window rug flag; a fully flagged fresh launch → 25.
    return {
      tokenAgeHours: ageHours,
      freshToken: true,
      score: Math.max(0, 100 - dings * 25),
      penalties,
    };
  }
}

export const globalRugScoring = new RugScoringService();
