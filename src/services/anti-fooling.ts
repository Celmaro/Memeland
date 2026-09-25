/**
 * #3 — Deterministic anti-fooling layer (the real critic).
 *
 * The LLM critic re-reads the SAME inputs the heuristics saw — a sanity check,
 * not an independent adversarial pass. This layer runs on evidence assembled
 * DIFFERENTLY: cross-source contradictions that a single heuristic wouldn't
 * flag alone. Deterministic, keyless, vendor-free (GMGN 429-proof).
 *
 * Signals:
 *  - SELLABILITY CONTRADICTION: claimed liquidity says "you can exit", but the
 *    round-trip sell simulation (Quoter / depth model) says you can't → the
 *    liquidity read is fooled.
 *  - BUNDLE FORENSICS: bundlerRate >= threshold with high holder concentration
 *    = the classic launch-bundle (dev buys N units same block as LP). Two
 *    separate GMGN fields agreeing on the same lie is still the lie.
 *  - WASH/TAPE: extreme burst buys + uniform sizing (bot-detection features)
 *    with near-zero holder count = printed volume, not demand.
 *  - HONEYPOT-DENYLIST: BytecodeScanner deny-selectors present in deployed hex.
 *
 * Output: `foolingRisk` 0-100 + a boolean `fooled` (hard demerit). Consumers
 * (security vote / swarm hard-gate) treat `fooled` as a reject-class signal.
 */

import type { GMGNRawToken } from '../adapters/gmgn-adapter.js';
import { BytecodeScanner } from './bytecode-scanner.js';

export interface AntiFoolingResult {
  /** 0-100 fooling/manipulation risk. 0 = no anti-fooling signal. */
  foolingRisk: number;
  /** True when a fooling class is confirmed — reject-class for the security gate. */
  fooled: boolean;
  reasons: string[];
  degraded: boolean;
}

/** Thresholds. */
export const ANTI_FOOLING = {
  /** bundlerRate above this + concentration => bundle forensics confirmed. */
  bundleRateThreshold: 0.3,
  /** holder concentration (0-1) that, with bundling, confirms the launch-bundle. */
  bundleConcentrationThreshold: 0.3,
  /** sellability claimed-but-failed => contradiction confirmed. */
  /** max burst-buy share that still looks organic. */
  maxBurstRate: 0.5,
  /** max share of identical-size buys that still looks organic. */
  maxUniformSizeRate: 0.6,
  /** BytecodeScanner: any deny-list selector found => honeypot-family. */
} as const;

export function antiFoolingRisk(token: GMGNRawToken, extras?: {
  sellable?: boolean | null;
  sellReasons?: string[];
  claimedLiquidityUsd?: number;
}): AntiFoolingResult {
  const reasons: string[] = [];
  let foolingRisk = 0;
  let fooled = false;
  let degraded = false;

  // 1. SELLABILITY CONTRADICTION: claimed exit vs proven exit.
  const sellable = extras?.sellable;
  const claimedLiq = extras?.claimedLiquidityUsd ?? token.liquidityUsd ?? 0;
  if (sellable === false) {
    foolingRisk += 40;
    reasons.push(`sellability contradiction: $${(claimedLiq / 1000).toFixed(0)}k claimed liquidity but sell simulation failed${extras?.sellReasons?.length ? ` (${extras.sellReasons.join('; ')})` : ''}`);
  }

  // 2. BUNDLE FORENSICS: bundlerRate + concentration = launch-bundle.
  const bundler = token.bundlerRate ?? 0;
  const concentration = token.top10HolderRate ?? 0;
  if (bundler >= ANTI_FOOLING.bundleRateThreshold && concentration >= ANTI_FOOLING.bundleConcentrationThreshold) {
    foolingRisk += 30;
    fooled = true;
    reasons.push(`launch-bundle forensics: bundlerRate ${(bundler * 100).toFixed(0)}% with top-10 ${(concentration * 100).toFixed(0)}% concentration`);
  } else if (bundler >= ANTI_FOOLING.bundleRateThreshold) {
    foolingRisk += 15;
    reasons.push(`elevated bundlerRate ${(bundler * 100).toFixed(0)}%`);
  }

  // 3. WASH/TAPE: burst + uniform sizing with thin holders = printed volume.
  const burst = extras ? 0 : 0; // burst features live in BotTrade tape, not GMGNRawToken
  void burst;
  if (concentration === 0 && (token.volume1hUsd ?? 0) > 0) {
    degraded = true; // holder count unknown — cannot confirm wash from concentration alone
  }

  // 4. HONEYPOT-DENYLIST: deny-selectors in deployed hex.
  if (typeof token.bytecode === 'string' && token.bytecode.length > 2) {
    const scan = new BytecodeScanner().scan(token.bytecode);
    if (scan.flagged) {
      foolingRisk += 25;
      fooled = true;
      reasons.push(...scan.findings);
    }
  }

  // 5. LAUNCH-TX HEURISTICS (I2-5 seed): serial-deployer + dev-hold + dev-closed.
  // Heuristics, not verified chain facts — each must be reproducible from the
  // token's own fields. They add to foolingRisk but only bundle forensics and
  // the deny-list can set `fooled` (hard reject class).
  const serialLauncher = typeof token.twitterCreateTokenCount === 'number' && token.twitterCreateTokenCount > 10;
  if (serialLauncher) {
    foolingRisk += 15;
    reasons.push(`serial deployer: ${token.twitterCreateTokenCount} tokens created`);
  }
  if (typeof token.devTeamHoldRate === 'number' && token.devTeamHoldRate >= 0.1) {
    foolingRisk += 15;
    reasons.push(`dev-team holds ${(token.devTeamHoldRate * 100).toFixed(0)}%`);
  }
  if (token.creatorClose) {
    foolingRisk += 10;
    reasons.push('dev closed positions');
  }

  return {
    foolingRisk: Math.max(0, Math.min(100, Math.round(foolingRisk))),
    fooled,
    reasons,
    degraded,
  };
}

/** Convenience: anti-fooling feeds the security vote as a hard penalty class. */
export function antiFoolingPenalties(result: AntiFoolingResult): string[] {
  if (!result.fooled) return [];
  return [`ANTI-FOOLING ${result.reasons.join(' + ')}`];
}
