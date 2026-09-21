/**
 * Q03 - GMGN wallet-scoring -> whale-voter uplift (SRC-001/002/100/101, SRC-081).
 * A deterministic per-token "wallet-score" computed from GMGN smart-money
 * ranking fields (concentration, maker tags, track-trade flow). Fail-closed:
 * missing/NaN fields degrade to a neutral baseline and never create a false win.
 */

import { ReputationMemory, type AegisSnapshot, type WalletProfile, type WalletTagCode } from './reputation-memory.js';

export interface WalletScoreInput {
  /** Fraction (0-1) of buys signed as bundles/rat-trader — distrust raises risk. */
  bundlerRate?: number | null;
  /** Fraction (0-1) of supply held by the top-10 holders — concentration risk. */
  top10HolderRate?: number | null;
  /** Number of distinct smart-money / KOL makers in the flow window. */
  distinctMakers?: number | null;
  /** Maker tags (e.g. 'smart_money', 'top_trader') seen in the flow. */
  makerTags?: string[];
  /** Net flow ratio (-1..1): +1 all buys, -1 all sells. */
  netFlowRatio?: number | null;
}

export interface WalletScoreResult {
  /** 0-100 wallet score. Neutral = 50 (no trustworthy data). */
  score: number;
  reasons: string[];
  /** True when any required input was missing/NaN (degraded to neutral). */
  degraded: boolean;
}

function finite01(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(1, v));
}

/**
 * Compute a fail-closed wallet-score. Every dimension is bounded and missing
 * inputs degrade toward neutral rather than producing a confident read.
 */
export function walletScore(input: WalletScoreInput): WalletScoreResult {
  const reasons: string[] = [];
  let degraded = false;
  let score = 50;

  const bundler = finite01(input.bundlerRate);
  const concentration = finite01(input.top10HolderRate);
  const netFlow = finite01(
    typeof input.netFlowRatio === 'number' && Number.isFinite(input.netFlowRatio)
      ? (input.netFlowRatio + 1) / 2
      : null
  );

  // Accumulation vs exit read: weight the flow, but distrust bundler-driven buys.
  if (netFlow !== null) {
    score += (netFlow - 0.5) * 40; // +/-20 around neutral
    reasons.push(`net flow ${(input.netFlowRatio as number).toFixed(2)}`);
  } else {
    degraded = true;
    reasons.push('net flow missing');
  }

  // Concentration: extreme top-10 concentration is a rug/exit-risk demerit.
  if (concentration !== null) {
    if (concentration > 0.7) {
      score -= 15;
      reasons.push(`top-10 concentration ${(concentration * 100).toFixed(0)}%`);
    } else if (concentration < 0.2) {
      score += 5;
      reasons.push('low top-10 concentration');
    }
  } else {
    degraded = true;
    reasons.push('concentration missing');
  }

  // Maker breadth: more distinct trusted makers is a positive accumulation read.
  if (typeof input.distinctMakers === 'number' && Number.isFinite(input.distinctMakers)) {
    if (input.distinctMakers >= 5) score += 10;
    else if (input.distinctMakers === 0) score -= 5;
  } else {
    degraded = true;
    reasons.push('maker breadth missing');
  }

  // Bundler distrust: cap the score when a chunk of buys look bundled.
  if (bundler !== null && bundler > 0.25) {
    score -= 20;
    reasons.push(`bundler rate ${(bundler * 100).toFixed(0)}% distrusts flow`);
  } else {
    // A missing bundler field does NOT necessarily degrade the score on its own
    // (it is a secondary field); leave it neutral.
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    degraded,
  };
}

/** Convenience: hydrate a WalletScoreInput from GMGN track-trade rows. */
export function walletScoreFromTrades(
  trades: Array<{ side: 'buy' | 'sell'; amountUsd: number; isFullClose: boolean; maker?: string; makerTags?: string[] }>
): WalletScoreResult {
  if (!trades || trades.length === 0) {
    return { score: 50, reasons: ['no smart-money flow data — neutral'], degraded: true };
  }
  let buys = 0;
  let sells = 0;
  const makers = new Set<string>();
  const tags = new Set<string>();
  for (const t of trades) {
    if (t.side === 'buy') buys += t.amountUsd;
    else sells += t.amountUsd;
    if (t.maker) makers.add(t.maker);
    for (const tg of t.makerTags ?? []) tags.add(tg);
  }
  const total = buys + sells;
  const netFlowRatio = total > 0 ? (buys - sells) / total : null;
  return walletScore({
    netFlowRatio,
    distinctMakers: makers.size,
    makerTags: [...tags],
  });
}

/**
 * PR12.b (SRC-142 lyc0603/copytrading): one-sample t-statistic on a wallet's
 * per-trade returns. Used as a profitability filter before copying a trader.
 * Fail-closed: with fewer than 2 returns or a zero sample std the signal is
 * null (cannot judge), never a false positive.
 */
export function walletTStat(returns: number[]): { t: number | null; mean: number; sampleStd: number; n: number } {
  const list = Array.isArray(returns) ? returns.filter((v) => Number.isFinite(v)) : [];
  const n = list.length;
  if (n < 2) return { t: null, mean: 0, sampleStd: 0, n };
  const mean = list.reduce((a, b) => a + b, 0) / n;
  const variance = list.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
  const sampleStd = Math.sqrt(variance);
  if (sampleStd === 0) return { t: null, mean, sampleStd, n };
  return { t: mean / (sampleStd / Math.sqrt(n)), mean, sampleStd, n };
}

export interface BotTrade {
  side: 'buy' | 'sell';
  amountUsd: number;
  at?: number;
  maker?: string;
}

export interface BotManipulationFeatures {
  /** Fraction of buy amounts landing on "round" sizes (e.g. multiples of 100). */
  roundAmountRate: number;
  /** Fraction of buys sharing the exact same size (bots size identically). */
  uniformSizeRate: number;
  /** Fraction of buys signed by the single most frequent maker. */
  topMakerBuyRate: number;
  /** Max buys within any 60s window / total buys (burst/wash signal). */
  maxBurstRate: number;
  /** Max buy size / median buy size (high ratio = one giant wash print). */
  sizeDispersion: number;
}

export interface BotManipulationResult {
  /** 0-100 manipulation/wash risk score. Neutral = 0 (no signal). */
  risk: number;
  features: BotManipulationFeatures;
  reasons: string[];
  degraded: boolean;
}

function isRoundAmount(amountUsd: number): boolean {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return false;
  for (const base of [100, 1000, 10000, 100000]) {
    const ratio = amountUsd / base;
    if (Math.abs(ratio - Math.round(ratio)) < 1e-6) return true;
  }
  return false;
}

/**
 * PR12.b bot-manipulation feature detector. Looks for wash-trade / burst /
 * uniform-sizing fingerprints in a wallet's trade tape. Fail-closed: empty or
 * all-sell tapes report a neutral 0 risk with `degraded: true`.
 */
export function botManipulationScore(trades: BotTrade[]): BotManipulationResult {
  const list = Array.isArray(trades) ? trades : [];
  const buys = list.filter((t) => t.side === 'buy' && Number.isFinite(t.amountUsd) && t.amountUsd > 0);
  const reasons: string[] = [];
  if (buys.length === 0) {
    return {
      risk: 0,
      features: {
        roundAmountRate: 0,
        uniformSizeRate: 0,
        topMakerBuyRate: 0,
        maxBurstRate: 0,
        sizeDispersion: 0,
      },
      reasons: ['no buy tape to fingerprint — neutral'],
      degraded: true,
    };
  }

  const roundAmountRate = buys.filter((t) => isRoundAmount(t.amountUsd)).length / buys.length;

  const sizeCounts = new Map<number, number>();
  for (const t of buys) sizeCounts.set(t.amountUsd, (sizeCounts.get(t.amountUsd) ?? 0) + 1);
  const mostCommonSize = Math.max(...Array.from(sizeCounts.values()));
  const uniformSizeRate = mostCommonSize / buys.length;

  const makerCounts = new Map<string, number>();
  for (const t of buys) {
    const maker = t.maker && t.maker.length > 0 ? t.maker : '?';
    makerCounts.set(maker, (makerCounts.get(maker) ?? 0) + 1);
  }
  const topMakerBuyRate = Math.max(...Array.from(makerCounts.values())) / buys.length;

  // Burst detection: max buys in any 60s window.
  const timed = buys.filter((t) => typeof t.at === 'number' && Number.isFinite(t.at as number));
  let maxBurstRate = 0;
  if (timed.length >= 2) {
    const sorted = timed.map((t) => t.at as number).sort((a, b) => a - b);
    let left = 0;
    let maxCount = 0;
    for (let right = 0; right < sorted.length; right++) {
      while (sorted[right] - sorted[left] > 60_000) left++;
      maxCount = Math.max(maxCount, right - left + 1);
    }
    maxBurstRate = maxCount / buys.length;
  }

  const sizes = buys.map((t) => t.amountUsd).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 1;
  const sizeDispersion = median > 0 ? (sizes[sizes.length - 1] ?? median) / median : 0;

  let risk = 0;
  if (roundAmountRate > 0.5) {
    risk += 20;
    reasons.push(`round-size clustering ${(roundAmountRate * 100).toFixed(0)}%`);
  }
  if (uniformSizeRate > 0.6) {
    risk += 30;
    reasons.push(`uniform sizing ${(uniformSizeRate * 100).toFixed(0)}%`);
  }
  if (topMakerBuyRate > 0.7) {
    risk += 25;
    reasons.push(`single-maker concentration ${(topMakerBuyRate * 100).toFixed(0)}%`);
  }
  if (maxBurstRate > 0.5) {
    risk += 25;
    reasons.push(`burst buys ${(maxBurstRate * 100).toFixed(0)}% in one minute`);
  }
  if (sizeDispersion > 20) {
    risk += 10;
    reasons.push(`size dispersion x${sizeDispersion.toFixed(0)}`);
  }

  return {
    risk: Math.max(0, Math.min(100, Math.round(risk))),
    features: { roundAmountRate, uniformSizeRate, topMakerBuyRate, maxBurstRate, sizeDispersion },
    reasons,
    degraded: false,
  };
}

export interface ReputationAwareWalletScore {
  /** Blended 0-100 score: wallet microstructure plus deployer reputation. */
  score: number;
  walletScore: number;
  reputationScore: number;
  tag: WalletTagCode;
  reasons: string[];
  /** True when the base wallet-score degraded or the deployer scored below the floor. */
  degraded: boolean;
}

/**
 * Wallet-tracker/scoring wrapper around the Kernel A reputation memory. Blends
 * the fail-closed GMGN wallet score with the AEGIS deployer reputation score,
 * then classifies the wallet with the meme-radar rule. Additive: it leaves the
 * underlying functions untouched and only layers a combined read.
 */
export function walletScoreWithReputation(
  input: WalletScoreInput,
  reputation: ReputationMemory,
  token: string,
  deployer: string,
  profile: WalletProfile,
  snapshot: AegisSnapshot,
): ReputationAwareWalletScore {
  const wallet = walletScore(input);
  const adjusted = reputation.reputationAdjustment(token, deployer, snapshot);
  const tag = reputation.classifyWallet(profile);
  const score = Math.max(0, Math.min(100, Math.round(wallet.score * 0.6 + adjusted.score * 0.4)));
  return {
    score,
    walletScore: wallet.score,
    reputationScore: adjusted.score,
    tag,
    reasons: [...wallet.reasons, ...adjusted.evidence, `wallet tag ${tag}`],
    degraded: wallet.degraded || adjusted.score < 60,
  };
}
