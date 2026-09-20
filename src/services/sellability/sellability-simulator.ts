/**
 * Kernel D / NERVE A11 + robinhood-lp-bot Adapt.
 * SellabilitySimulator models an eth_simulateV1-style round-trip sell, and
 * VolumeSpikeDetector adapts the lp-bot trailing-baseline volume spike. Both
 * fail closed: blocked sim, stale/unpinned block, missing liquidity, or
 * over-limit slippage resolve to sellable=false score 0.
 */

export interface SimulateResult {
  simulated: boolean;
  sellable: boolean;
}

export interface SellTrade {
  /** Pooled sell-side liquidity in USD. */
  liquidityUsd?: number;
  /** Expected slippage percent for the round-trip sell. */
  expectedSlippagePct?: number;
  /** Slippage cap percent; above this the sell fails closed. */
  maxSlippagePct?: number;
  /** Explicit age of the pinned block (ms). */
  blockAgeMs?: number;
  /** When the block was pinned (ms epoch). */
  pinnedAt?: number;
}

export interface SellCheckResult {
  sellable: boolean;
  score: number;
  reasons: string[];
}

export interface SellabilitySimulatorOptions {
  /** Clock used for pinnedAt staleness. */
  now?: () => number;
  /** Block age (ms) beyond which a pin is stale. */
  staleAfterMs?: number;
  /** Liquidity (USD) that yields a full liquidity score. */
  targetLiquidityUsd?: number;
  /** Default slippage cap percent when the trade omits one. */
  defaultMaxSlippagePct?: number;
}

type SimulateFn = (trade: SellTrade) => Promise<SimulateResult> | SimulateResult;

const DEFAULT_STALE_AFTER_MS = 60_000;
const DEFAULT_TARGET_LIQUIDITY_USD = 1_000;
const DEFAULT_MAX_SLIPPAGE_PCT = 5;

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export class SellabilitySimulator {
  private readonly now: () => number;
  private readonly staleAfterMs: number;
  private readonly targetLiquidityUsd: number;
  private readonly defaultMaxSlippagePct: number;

  constructor(
    private readonly simulate: SimulateFn,
    options: SellabilitySimulatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.targetLiquidityUsd = options.targetLiquidityUsd ?? DEFAULT_TARGET_LIQUIDITY_USD;
    this.defaultMaxSlippagePct = options.defaultMaxSlippagePct ?? DEFAULT_MAX_SLIPPAGE_PCT;
  }

  private blockAge(trade: SellTrade): number | undefined {
    if (trade.blockAgeMs !== undefined) return trade.blockAgeMs;
    if (trade.pinnedAt !== undefined) return Math.max(0, this.now() - trade.pinnedAt);
    return undefined;
  }

  async check(trade: SellTrade): Promise<SellCheckResult> {
    const age = this.blockAge(trade);
    if (age === undefined || age > this.staleAfterMs) {
      return { sellable: false, score: 0, reasons: ['block not pinned or stale - score 0'] };
    }
    const sim = await this.simulate(trade);
    if (!sim.simulated || !sim.sellable) {
      return { sellable: false, score: 0, reasons: ['round-trip sell blocked - score 0'] };
    }
    const { liquidityUsd } = trade;
    if (typeof liquidityUsd !== 'number' || !Number.isFinite(liquidityUsd) || liquidityUsd <= 0) {
      return { sellable: false, score: 0, reasons: ['missing liquidity - score 0'] };
    }
    const maxSlippagePct = trade.maxSlippagePct ?? this.defaultMaxSlippagePct;
    const expectedSlippagePct = trade.expectedSlippagePct;
    if (
      typeof expectedSlippagePct === 'number' &&
      Number.isFinite(expectedSlippagePct) &&
      maxSlippagePct > 0 &&
      expectedSlippagePct > maxSlippagePct
    ) {
      return { sellable: false, score: 0, reasons: ['expected slippage exceeds limit - score 0'] };
    }
    const liquidityScore = clamp((liquidityUsd / this.targetLiquidityUsd) * 100, 0, 100);
    let slippageScore = 100;
    if (typeof expectedSlippagePct === 'number' && Number.isFinite(expectedSlippagePct) && maxSlippagePct > 0) {
      slippageScore = clamp(100 - (expectedSlippagePct / maxSlippagePct) * 100, 0, 100);
    }
    const score = Math.round((liquidityScore + slippageScore) / 2);
    return { sellable: true, score, reasons: ['round-trip sell simulated OK'] };
  }
}

export interface VolumeBar {
  time: number;
  volumeUsd: number;
}

export interface SpikeResult {
  spiked: boolean;
  ratio: number;
}

export interface VolumeSpikeDetectorOptions {
  threshold?: number;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export class VolumeSpikeDetector {
  private readonly threshold: number;

  constructor(options: VolumeSpikeDetectorOptions = {}) {
    this.threshold = options.threshold ?? 3;
  }

  detect(bars: readonly VolumeBar[]): SpikeResult {
    if (bars.length < 2) return { spiked: false, ratio: 0 };
    const latest = bars[bars.length - 1]!.volumeUsd;
    const baseline = median(bars.slice(0, -1).map((bar) => bar.volumeUsd));
    if (!Number.isFinite(baseline) || baseline <= 0) return { spiked: false, ratio: 0 };
    const ratio = latest / baseline;
    return { spiked: ratio >= this.threshold, ratio };
  }
}
