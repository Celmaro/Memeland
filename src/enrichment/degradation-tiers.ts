/**
 * 6.5 — Hard-gate vs soft-feature degradation.
 *
 * The system fail-closes broadly on missing data. Distinguish:
 *  - HARD gates (must-have for safety): security, sellability, on-chain existence
 *    → fail-closed.
 *  - SOFT features (degrade gracefully): Arkham entity labels, sentiment, klines
 *    → mark low-confidence and apply a risk discount instead of killing the pass.
 *
 * This generalizes the `feed-down ≠ dead-pair` distinction we already proved for
 * volume across the whole enrichment layer: a missing NON-critical feature must not
 * abort a pass, but a missing safety-critical one must.
 */

/** A feature the pipeline consumes. */
export type FeatureId =
  | 'security'
  | 'sellability'
  | 'onchain-existence'
  | 'arkham-entity'
  | 'sentiment'
  | 'klines'
  | 'liquidity'
  | 'volume';

/** HARD = fail-closed when missing; SOFT = degrade with a risk discount. */
export type FeatureTier = 'hard' | 'soft';

/** Static classification of every enrichment feature. */
export const FEATURE_TIERS: Record<FeatureId, FeatureTier> = {
  // Safety-critical — must never trade on missing data.
  security: 'hard',
  sellability: 'hard',
  'onchain-existence': 'hard',
  // Enrichment — nice-to-have; degrade, don't abort.
  'arkham-entity': 'soft',
  sentiment: 'soft',
  klines: 'soft',
  // Feed data — missing volume/liquidity is already distinguished (I1-4) but
  // treat them as soft here so a blip degrades rather than kills.
  liquidity: 'soft',
  volume: 'soft',
};

export interface FeatureAvailability {
  /** feature id → true when the value is present/current. */
  available: Partial<Record<FeatureId, boolean>>;
}

export interface DegradationResult {
  /** Whether any HARD feature is unavailable → the pass must fail closed. */
  hardGated: boolean;
  /** Soft features that were unavailable (to log / mark low-confidence). */
  degradedSoft: FeatureId[];
  /** Soft features that were present. */
  presentSoft: FeatureId[];
  /** Risk multiplier applied to confidence when soft features degrade (1 = none). */
  riskDiscount: number;
}

/** Default discount per degraded soft feature (multiplicative, capped). */
const DEFAULT_DISCOUNT = 0.92;
const MIN_DISCOUNT = 0.5;

/**
 * Evaluate feature availability. Fails closed on any missing HARD feature; missing
 * SOFT features each apply a multiplicative risk discount instead of killing.
 */
export function evaluateDegradation(
  availability: FeatureAvailability,
  discountPerSoft: number = DEFAULT_DISCOUNT,
): DegradationResult {
  const hardGated = (Object.keys(FEATURE_TIERS) as FeatureId[]).some(
    (f) => FEATURE_TIERS[f] === 'hard' && availability.available[f] !== true,
  );
  const degradedSoft: FeatureId[] = [];
  const presentSoft: FeatureId[] = [];
  for (const f of Object.keys(FEATURE_TIERS) as FeatureId[]) {
    if (FEATURE_TIERS[f] !== 'soft') continue;
    if (availability.available[f] === true) presentSoft.push(f);
    else degradedSoft.push(f); // absent or explicitly false → degraded
  }
  let riskDiscount = 1;
  for (let i = 0; i < degradedSoft.length; i++) riskDiscount *= discountPerSoft;
  riskDiscount = Math.max(MIN_DISCOUNT, riskDiscount);
  return { hardGated, degradedSoft, presentSoft, riskDiscount };
}

/** Apply a risk discount to a 0-100 confidence score. */
export function applyRiskDiscount(confidence: number, discount: number): number {
  return Math.max(0, Math.min(100, confidence * discount));
}

/** Human-readable reason summarizing a degradation result. */
export function degradationReason(r: DegradationResult): string {
  if (r.hardGated) return 'HARD gate failed — missing safety-critical data';
  if (r.degradedSoft.length === 0) return 'no degradation';
  return `soft degrade (${r.degradedSoft.join(', ')}), discount ×${r.riskDiscount.toFixed(2)}`;
}
