/**
 * Bot-Detection scoring (WWW'26, arXiv 2601.08641 — "bundling detection").
 *
 * Materializes the bundle / sniper / gradual-bundle / wash-trade signals that
 * a memecoin launch-venue would expose as raw buyer-side indicators, and folds
 * them into a single deterministic 0-100 bot-risk score. This is a SAFETY
 * scorer: it is fail-open on missing data (unknown fields contribute 0) and is
 * intentionally transparent — each contribution is a named, bounded signal
 * that shows up in `reasons`, never a black box.
 *
 * The score feeds:
 *   - the whale voter (caps accumulation evidence when the flow looks bot-driven)
 *   - the security/safety voter (adds bot-risk penalties)
 *   - MarketSentinel's market-wide bot-risk window (kill-switch trip source)
 *
 * Approximations (we do not have per-tx submitter graphs on Robinhood chain):
 *   - bundle          → `bundlerRate` (fraction of buys signed as bundles)
 *   - sniper          → high bundler/wash on a token younger than `sniperAgeHours`
 *   - gradual-bundle  → bundle + linked-trading (`ratTraderAmountRate`) or
 *                        non-trivial dev holding → staged accumulation
 *   - concentration   → `top10HolderRate` (a side effect of bundling)
 */

import type { GMGNRawToken } from '../adapters/gmgn-adapter.js';

export type BotSeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface BotRiskSignals {
  bundle: boolean;
  sniper: boolean;
  gradualBundle: boolean;
  washTrading: boolean;
  concentration: boolean;
}

export interface BotDetectionReport {
  address: string;
  /** Aggregated 0-100 bot risk. 0 = no bot evidence, 100 = clear fabrication. */
  botRisk: number;
  signals: BotRiskSignals;
  severity: BotSeverity;
  reasons: string[];
  /** True when `botRisk` clears the operational kill-switch threshold. */
  needsBotKillSwitch: boolean;
}

export interface BotDetectionConfig {
  /** bundlerRate above this counts as a bundle signal (fraction). */
  bundleRiskThreshold: number;
  /** bundlerRate above this, combined with a young token, counts as sniper. */
  sniperBundlerThreshold: number;
  /** Max token age (hours) for a sniper signal to be plausible. */
  sniperAgeHours: number;
  /** top10HolderRate above this counts as concentration. */
  top10Threshold: number;
  /** ratTraderAmountRate above this is treated as linked/cab-al trading. */
  ratTraderThreshold: number;
  /** devTeamHoldRate above this is treated as staged dev accumulation. */
  devHoldingThreshold: number;
  /** Fixed points per active signal (sum ≈ 70 below the magnitude bonus). */
  bundleBaseScore: number;
  sniperBaseScore: number;
  gradualBaseScore: number;
  washBaseScore: number;
  concentrationBaseScore: number;
  devBaseScore: number;
  /** Magnitude bonus ceiling (adds on top of the base signals, clamped to 30). */
  maxMagnitudeBonus: number;
  /** botRisk >= this sets `needsBotKillSwitch` (used by MarketSentinel). */
  killSwitchThreshold: number;
}

const DEFAULT_CONFIG: BotDetectionConfig = {
  bundleRiskThreshold: 0.25,
  sniperBundlerThreshold: 0.3,
  sniperAgeHours: 0.15, // ~9 minutes post-launch
  top10Threshold: 0.35,
  ratTraderThreshold: 0.1,
  devHoldingThreshold: 0.1,
  bundleBaseScore: 30,
  sniperBaseScore: 25,
  gradualBaseScore: 15,
  washBaseScore: 15,
  concentrationBaseScore: 10,
  devBaseScore: 5,
  maxMagnitudeBonus: 30,
  killSwitchThreshold: 80,
};

function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

export function severityFor(risk: number): BotSeverity {
  if (risk >= 85) return 'critical';
  if (risk >= 65) return 'high';
  if (risk >= 45) return 'medium';
  if (risk >= 25) return 'low';
  return 'none';
}

export class BotDetectionService {
  private config: BotDetectionConfig;

  constructor(config?: Partial<BotDetectionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Deterministic bot-risk analysis for a single token. Never throws. */
  public analyze(token: GMGNRawToken): BotDetectionReport {
    const c = this.config;
    const b = token.bundlerRate ?? 0;
    const top10 = token.top10HolderRate ?? 0;
    const dev = token.devTeamHoldRate ?? 0;
    const rats = token.ratTraderAmountRate ?? 0;
    const wash = token.isWashTrading === true;
    const ageHours =
      token.creationTimestamp && token.creationTimestamp > 0
        ? (Date.now() - token.creationTimestamp * 1000) / 3_600_000
        : Infinity;
    const young = ageHours <= c.sniperAgeHours;

    const bundle = b > c.bundleRiskThreshold;
    const sniper = young && (b > c.sniperBundlerThreshold || wash);
    const gradualBundle = bundle && (rats > c.ratTraderThreshold || dev > c.devHoldingThreshold);
    const concentration = top10 > c.top10Threshold;
    const devHolding = dev > c.devHoldingThreshold;

    const signals: BotRiskSignals = { bundle, sniper, gradualBundle, washTrading: wash, concentration };

    let score = 0;
    if (bundle) score += c.bundleBaseScore;
    if (sniper) score += c.sniperBaseScore;
    if (gradualBundle) score += c.gradualBaseScore;
    if (wash) score += c.washBaseScore;
    if (concentration) score += c.concentrationBaseScore;
    if (devHolding) score += c.devBaseScore;

    // Magnitude bonus — rewards large raw ratios even under the step thresholds.
    const magnitudeBonus = Math.min(c.maxMagnitudeBonus, (b + top10 + rats) * 20);
    score += magnitudeBonus;

    const botRisk = clamp(score);
    const needsBotKillSwitch = botRisk >= c.killSwitchThreshold;

    const reasons: string[] = [];
    if (bundle) reasons.push(`bundle rate ${(b * 100).toFixed(0)}%`);
    if (sniper) reasons.push(`sniper-shaped entry (${ageHours.toFixed(2)}h old)`);
    if (gradualBundle) reasons.push('gradual bundle (linked/held accumulation)');
    if (wash) reasons.push('wash trading flagged');
    if (concentration) reasons.push(`top-10 concentration ${(top10 * 100).toFixed(0)}%`);
    if (devHolding) reasons.push(`dev holding ${(dev * 100).toFixed(0)}%`);
    if (!bundle && !sniper && !gradualBundle && !wash && !concentration && !devHolding) {
      reasons.push('no bot evidence (fail-open neutral)');
    }
    if (needsBotKillSwitch) reasons.push(`bot risk ${botRisk} >= kill switch ${c.killSwitchThreshold}`);

    return { address: token.address, botRisk, signals, severity: severityFor(botRisk), reasons, needsBotKillSwitch };
  }
}

export const globalBotDetection = new BotDetectionService();

// ───────────────────────────────────────────────────────────────────────────
// Market-wide bot-risk window — MarketSentinel's decoupled probe source.
// The screening loop records each assessed token; the Sentinel reads the
// window from its OWN scheduler so bot-risk never blocks signal evaluation.
// ───────────────────────────────────────────────────────────────────────────

const MAX_SAMPLES = 200;

export class BotRiskWindow {
  private samples: number[] = [];

  public record(botRisk: number): void {
    if (!Number.isFinite(botRisk)) return;
    this.samples.push(Math.max(0, Math.min(100, botRisk)));
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  /** Average bot risk and fraction of samples at/above `highThreshold` (e.g. 80). */
  public snapshot(highThreshold = 80): { avg: number; highFraction: number; sampleCount: number } {
    const n = this.samples.length;
    if (n === 0) return { avg: 0, highFraction: 0, sampleCount: 0 };
    const avg = this.samples.reduce((a, b) => a + b, 0) / n;
    const high = this.samples.filter((s) => s >= highThreshold).length;
    return { avg: Math.round(avg * 10) / 10, highFraction: high / n, sampleCount: n };
  }

  public reset(): void {
    this.samples = [];
  }
}

export const globalBotRiskWindow = new BotRiskWindow();

/** Convenience: record into the shared window (used by the screening agent). */
export function recordBotRiskSample(botRisk: number): void {
  globalBotRiskWindow.record(botRisk);
}
