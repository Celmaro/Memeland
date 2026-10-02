/**
 * Q13 - Cost-gated throttling + cross-market sizing (SRC-262 grok-trading-desk
 * fail-closed vetoes + cost gating, SRC-261 propose-vs-decide). IMPORTANT: the
 * underlying `COST_CAP_USD` accounts against TRADE NOTIONAL (the `trySpend`
 * unit is the executed USD size), so it behaves as a *cumulative executed
 * notional cap*, NOT a fee/cost budget. It throttles further fills once the
 * sum of submitted notional crosses the cap. Correlated exposures sum against a
 * shared cap. Reset is explicit (risk-layer convention).
 */

export class CostGate {
  private spent = 0;

  constructor(private readonly capUsd: number) {}

  get spentUsd(): number {
    return this.spent;
  }

  get remainingUsd(): number {
    return Math.max(0, this.capUsd - this.spent);
  }

  /** True when recording this incremental cost stays within the cap. */
  canSubmit(costUsd: number): boolean {
    return Number.isFinite(costUsd) && costUsd >= 0 && this.spent + costUsd <= this.capUsd;
  }

  /** Record a fill cost (only if within budget). Returns false when blocked. */
  recordFill(costUsd: number): boolean {
    if (!this.canSubmit(costUsd)) return false;
    this.spent += costUsd;
    return true;
  }

  reset(): void {
    this.spent = 0;
  }
}

/** Sum correlated exposures against a shared cap; returns remaining headroom. */
export function crossMarketHeadroom(correlatedUsd: number[], sharedCapUsd: number): {
  totalUsd: number;
  headroomUsd: number;
  overCap: boolean;
} {
  const totalUsd = correlatedUsd.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
  return { totalUsd, headroomUsd: Math.max(0, sharedCapUsd - totalUsd), overCap: totalUsd > sharedCapUsd };
}
