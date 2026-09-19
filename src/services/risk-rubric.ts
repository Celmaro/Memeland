/**
 * Q12 - Portable, explainable risk rubric (SRC-084, SRC-166 weighted safety
 * score with missing-data-never-clean, SRC-105 concentration/spike/metrics).
 * Deterministic weighted factors with per-factor deductions; a missing required
 * factor can never yield a clean score (fail-open-to-caution).
 */

export interface RubricFactorInput {
  name: string;
  /** 0-1 contribution weight (relative; normalized internally). */
  weight: number;
  /** 0-1 quality/safety score for the factor (1 = safest). */
  score01: number;
  /** When true, a missing value forces a non-clean verdict. */
  required?: boolean;
}

export interface RubricFactor {
  name: string;
  weight: number;
  score01: number;
  /** Points deducted from a 100 baseline by this factor. */
  deduction: number;
  missing: boolean;
}

export interface RiskRubric {
  factors: RubricFactor[];
  /** 0-100 overall safety score (higher = safer). */
  overall: number;
  /** False when any required factor is missing (never "clean"). */
  clean: boolean;
  expiresAt?: number;
}

export interface RubricOptions {
  expiresAt?: number;
}

/** Map a set of SRC-105 style metric inputs to rubric factors. */
export function securityMetricFactors(input: {
  concentration?: number;
  spikePct?: number;
  volatility?: number;
  liquidityUsd?: number;
}): RubricFactorInput[] {
  const factors: RubricFactorInput[] = [];
  factors.push({
    name: 'concentration',
    weight: 0.3,
    score01: typeof input.concentration === 'number' ? Math.max(0, Math.min(1, 1 - input.concentration)) : NaN,
    required: true,
  });
  factors.push({
    name: 'liquidity',
    weight: 0.3,
    score01: typeof input.liquidityUsd === 'number' ? Math.max(0, Math.min(1, Math.min(1, input.liquidityUsd / 100_000))) : NaN,
    required: true,
  });
  factors.push({
    name: 'spike',
    weight: 0.2,
    score01: typeof input.spikePct === 'number' ? Math.max(0, Math.min(1, 1 - input.spikePct / 300)) : NaN,
  });
  factors.push({
    name: 'volatility',
    weight: 0.2,
    score01: typeof input.volatility === 'number' ? Math.max(0, Math.min(1, 1 - input.volatility / 100)) : NaN,
  });
  // Keep NaN score01 so `computeRubric` can detect the missing required factor.
  return factors;
}

export function computeRubric(factors: RubricFactorInput[], opts: RubricOptions = {}): RiskRubric {
  let missingRequired = false;
  const resolved: RubricFactor[] = factors.map((f) => {
    const missing = !Number.isFinite(f.score01) || (typeof f.score01 === 'number' && (f.score01 < 0 || f.score01 > 1));
    const score01 = missing ? 0 : Math.max(0, Math.min(1, f.score01));
    if (missing && f.required) missingRequired = true;
    const deduction = Math.round(f.weight * (1 - score01) * 100);
    return { name: f.name, weight: f.weight, score01, deduction, missing };
  });

  const totalWeight = resolved.reduce((a, f) => a + f.weight, 0);
  const weighted = resolved.reduce((a, f) => a + f.weight * f.score01, 0);
  const overall = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) : 0;
  return {
    factors: resolved,
    overall: Math.max(0, Math.min(100, overall)),
    clean: !missingRequired,
    expiresAt: opts.expiresAt,
  };
}
