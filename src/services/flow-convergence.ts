/**
 * Q05 - Accumulation + convergence heuristic (SRC-038/080/210).
 * Deterministic, chain-portable scorer: N DISTRIBUTED wallets accumulating a
 * token within a time window (with balance-delta buys) raise a convergence
 * score; a single high-balance whale does NOT independently count; stale or
 * sparse windows score neutral (never a false positive). Fail-closed and
 * config-capped.
 */

export interface BuyEvent {
  wallet: string;
  amountUsd: number;
  timestamp: number;
}

export interface FlowConvergenceConfig {
  /** Window length in ms for "within-window" accumulation. Default 15 min. */
  windowMs?: number;
  /** Distinct wallets required before convergence can register. Default 3. */
  minWallets?: number;
  /** Max per-wallet share (0-1) of window buys before it is "concentrated". */
  maxWalletShare?: number;
  /** Score ceiling when requirements are met. Default 90. */
  maxScore?: number;
}

export interface FlowConvergenceResult {
  score: number;
  reasons: string[];
  distinctWallets: number;
  windowTotalUsd: number;
  converged: boolean;
}

/**
 * Score 0-100 accumulation convergence for a token within a window. Requires
 * `minWallets` DISTINCT wallets and distributes the score by breadth and
 * balance-delta volume, capped by `maxScore`. A dominant single wallet keeps
 * the score low (concentration is NOT convergence).
 */
export function flowConvergenceScore(
  buys: BuyEvent[],
  config: FlowConvergenceConfig = {},
  now = Date.now()
): FlowConvergenceResult {
  const windowMs = config.windowMs ?? 15 * 60 * 1000;
  const minWallets = config.minWallets ?? 3;
  const maxWalletShare = config.maxWalletShare ?? 0.5;
  const maxScore = config.maxScore ?? 90;

  const recent = (buys ?? []).filter((b) => b && now - b.timestamp <= windowMs && b.amountUsd > 0);
  const distinctWallets = new Set(recent.map((b) => b.wallet)).size;
  const windowTotalUsd = recent.reduce((a, b) => a + b.amountUsd, 0);

  if (recent.length === 0) {
    return {
      score: 50,
      reasons: ['no in-window buys — neutral'],
      distinctWallets: 0,
      windowTotalUsd: 0,
      converged: false,
    };
  }
  if (distinctWallets < minWallets) {
    return {
      score: 50,
      reasons: [`only ${distinctWallets} distinct wallet(s) — below min ${minWallets}`],
      distinctWallets,
      windowTotalUsd,
      converged: false,
    };
  }

  // Dominance check: if any single wallet accounts for too much of the window
  // volume, the flow is concentrated, not convergent.
  const byWallet = new Map<string, number>();
  for (const b of recent) byWallet.set(b.wallet, (byWallet.get(b.wallet) ?? 0) + b.amountUsd);
  const topShare = Math.max(...[...byWallet.values()]);
  const maxShare = windowTotalUsd > 0 ? topShare / windowTotalUsd : 0;

  if (maxShare > maxWalletShare) {
    return {
      score: 50,
      reasons: [`single wallet drives ${(maxShare * 100).toFixed(0)}% of window — concentrated, not converged`],
      distinctWallets,
      windowTotalUsd,
      converged: false,
    };
  }

  // Breadth (0-100) by distinct wallets vs a soft target, blended with volume.
  const breadth = Math.min(1, distinctWallets / 8); // 8+ wallets => full breadth
  const volume = Math.min(1, windowTotalUsd / 50_000); // $50k window => full volume
  let score = Math.round(maxScore * (0.6 * breadth + 0.4 * volume));
  const reasons = [
    `${distinctWallets} distinct wallets / $${(windowTotalUsd / 1000).toFixed(1)}k in-window`,
    'distributed accumulation',
  ];
  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    distinctWallets,
    windowTotalUsd,
    converged: true,
  };
}
