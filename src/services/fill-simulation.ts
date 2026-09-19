/**
 * Q08 - Fill simulation + paper-broker fill engine (SRC-213 slippage-impact,
 * SRC-187 AMM simulate/curve quote math). Pure splash model: price impact and
 * expected slippage derive from on-chain pool depth. A paper fill records slip
 * vs. mid and NEVER touches a live executor.
 */

export interface PoolDepth {
  /** Pooled liquidity in USD (depth against which notional moves price). */
  liquidityUsd?: number;
  /** Token-side reserves (optional, unused by the linear splash model). */
  tokenBalance?: number;
}

export interface FillSimulationInput {
  notionalUsd: number;
  midPriceUsd: number;
  depth: PoolDepth;
}

export interface FillSimulationResult {
  /** Price impact percent (0-100+). Monotonic in notional/liquidity. */
  impactPct: number;
  /** Expected execution slippage percent vs mid. */
  expectedSlipPct: number;
  /** Price that a fill would print under this impact. */
  fillPriceUsd: number;
  /** True when depth is insufficient — fail-closed refusal, not best-effort. */
  refused: boolean;
  reason?: string;
}

/**
 * Constant-product splash estimate: impact ~= notional / liquidity. Monotonic
 * in notional and inverse in depth. Zero/illiquid depth refuses (fail-closed).
 */
export function simulateFill(input: FillSimulationInput): FillSimulationResult {
  const { notionalUsd, midPriceUsd, depth } = input;
  const liquidityUsd = depth?.liquidityUsd;
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
    return { impactPct: 0, expectedSlipPct: 0, fillPriceUsd: midPriceUsd, refused: true, reason: 'non-positive notional' };
  }
  if (typeof liquidityUsd !== 'number' || !Number.isFinite(liquidityUsd) || liquidityUsd <= 0) {
    return { impactPct: 0, expectedSlipPct: 0, fillPriceUsd: midPriceUsd, refused: true, reason: 'zero/illiquid depth' };
  }
  const impactPct = (notionalUsd / liquidityUsd) * 100;
  const expectedSlipPct = impactPct;
  return {
    impactPct,
    expectedSlipPct,
    fillPriceUsd: midPriceUsd * (1 + impactPct / 100),
    refused: false,
  };
}

export interface PaperFill {
  token: string;
  chainId: number;
  sizeUsd: number;
  slipPct: number;
  fillPriceUsd: number;
  timestamp: number;
  simulated: true;
}

export interface PaperFillRequest {
  token: string;
  chainId: number;
  notionalUsd: number;
  midPriceUsd: number;
  depth: PoolDepth;
}

/**
 * Paper-broker fill engine behind the approval gates. Marks fills, logs slip
 * vs. mid, and is structurally incapable of submitting to a live executor.
 */
export class PaperFillBroker {
  private fills: PaperFill[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  get log(): readonly PaperFill[] {
    return this.fills;
  }

  async execute(req: PaperFillRequest): Promise<{ accepted: boolean; fill?: PaperFill; reason?: string }> {
    const sim = simulateFill({ notionalUsd: req.notionalUsd, midPriceUsd: req.midPriceUsd, depth: req.depth });
    if (sim.refused) return { accepted: false, reason: sim.reason };
    const fill: PaperFill = {
      token: req.token,
      chainId: req.chainId,
      sizeUsd: req.notionalUsd,
      slipPct: sim.expectedSlipPct,
      fillPriceUsd: sim.fillPriceUsd,
      timestamp: this.now(),
      simulated: true,
    };
    this.fills.push(fill);
    return { accepted: true, fill };
  }
}
