/**
 * Q03 - GMGN wallet-scoring -> whale-voter uplift (SRC-001/002/100/101, SRC-081).
 * A deterministic per-token "wallet-score" computed from GMGN smart-money
 * ranking fields (concentration, maker tags, track-trade flow). Fail-closed:
 * missing/NaN fields degrade to a neutral baseline and never create a false win.
 */

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
