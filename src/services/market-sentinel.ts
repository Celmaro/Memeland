/**
 * MarketSentinel — decoupled risk-service (arXiv 2601.04687).
 *
 * A safety monitor that watches MARKET-WIDE risk indicators and flips the
 * RiskEngineV2 kill-switch, but is structurally decoupled from the trading
 * loop: it runs on its own scheduler, never in `evaluateSignal`, and never
 * gates an individual trade. It trips only on PERSISTENT evidence (consecutive
 * passes above threshold) so a single noisy sample cannot halt trading, and it
 * is fail-open on probe errors (an outage decrements the persistence counter —
 * it can never trip the kill-switch from missing data).
 */

import type { BotRiskWindow } from './bot-detection.js';
import { globalRiskEngineV2 } from '../orchestrator/risk-engine-v2.js';
import { type MarketRegimeFilter } from './market-regime.js';

export interface MarketSentinelSample {
  /** Market-wide average bot risk 0-100 (e.g. globalBotRiskWindow avg). */
  botRisk: number;
  /** 0-1 — fraction of window samples flagged high (>= kill-switch threshold). */
  highRiskFraction: number;
  /** Macro / whale risk-off from the regime filter. */
  regimeRiskOff: boolean;
}

export interface MarketSentinelConfig {
  /** Average bot risk at/above which a pass counts toward a trip. */
  tripBotRisk: number;
  /** Combined high-risk fraction required alongside `tripBotRisk`. */
  highRiskFractionThreshold: number;
  /** Macro risk-off alone can count toward a trip when true. */
  regimeRiskOffTrips: boolean;
  /** Consecutive qualifying passes required before the kill-switch trips. */
  requireConsecutive: number;
  /** Minimum interval between kill-switch trips (prevents re-trip churn). */
  cooldownMs: number;
}

export interface MarketSentinelStatus {
  lastCheckedAt: number | null;
  killSwitchEngagedReason: string | null;
  consecutiveRiskPasses: number;
  lastSample: MarketSentinelSample | null;
}

const DEFAULT_CONFIG: MarketSentinelConfig = {
  tripBotRisk: 80,
  highRiskFractionThreshold: 0.2,
  regimeRiskOffTrips: true,
  requireConsecutive: 3,
  cooldownMs: 15 * 60 * 1000,
};

export class MarketSentinel {
  private config: MarketSentinelConfig;
  private probe: () => MarketSentinelSample;
  private tripKillSwitch: (reason: string) => void;
  private status: MarketSentinelStatus = {
    lastCheckedAt: null,
    killSwitchEngagedReason: null,
    consecutiveRiskPasses: 0,
    lastSample: null,
  };
  private lastTripAt = 0;

  constructor(
    probe: () => MarketSentinelSample,
    tripKillSwitch: (reason: string) => void = (reason: string) =>
      globalRiskEngineV2.activateKillSwitch(reason),
    config?: Partial<MarketSentinelConfig>
  ) {
    this.probe = probe;
    this.tripKillSwitch = tripKillSwitch;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * One sentinel pass. Runs from a scheduler OUTSIDE the trading loop.
   * Fail-open: a throwing probe clears persistence and never trips.
   */
  public checkAndReact(): MarketSentinelStatus {
    const now = Date.now();
    this.status.lastCheckedAt = now;

    let sample: MarketSentinelSample;
    try {
      sample = this.probe();
    } catch (err: any) {
      console.warn(`[MARKET SENTINEL] Probe unavailable (${err.message}) — fail-open, no trip.`);
      this.status.consecutiveRiskPasses = 0;
      this.status.lastSample = null;
      return this.status;
    }

    this.status.lastSample = sample;
    const qualifies =
      (sample.botRisk >= this.config.tripBotRisk && sample.highRiskFraction >= this.config.highRiskFractionThreshold) ||
      (this.config.regimeRiskOffTrips && sample.regimeRiskOff === true);

    this.status.consecutiveRiskPasses = qualifies ? this.status.consecutiveRiskPasses + 1 : 0;

    if (
      qualifies &&
      this.status.consecutiveRiskPasses >= this.config.requireConsecutive &&
      now - this.lastTripAt >= this.config.cooldownMs
    ) {
      const reason = this.buildTripReason(sample);
      this.lastTripAt = now;
      this.status.killSwitchEngagedReason = reason;
      console.error(`🚨 [MARKET SENTINEL] Killing trading: ${reason}`);
      this.tripKillSwitch(reason);
    } else if (!qualifies) {
      this.status.killSwitchEngagedReason = this.status.killSwitchEngagedReason;
    }

    return this.status;
  }

  public getStatus(): MarketSentinelStatus {
    return { ...this.status, lastSample: this.status.lastSample ? { ...this.status.lastSample } : null };
  }

  public setConfig(config: Partial<MarketSentinelConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private buildTripReason(sample: MarketSentinelSample): string {
    const parts: string[] = [];
    if (sample.botRisk >= this.config.tripBotRisk) {
      parts.push(`market bot-risk ${sample.botRisk} with ${(sample.highRiskFraction * 100).toFixed(0)}% high-risk tokens`);
    }
    if (sample.regimeRiskOff) parts.push('macro risk-off');
    const forN = this.status.consecutiveRiskPasses;
    return `MarketSentinel killed trading after ${forN} persistent ${parts.join(' + ') || 'risk'} passes.`;
  }
}

/**
 * Process-wide singleton wired to the shared bot-risk window + market regime.
 * Dropped into index.ts on its own setInterval — decoupled from the screening
 * loop.
 */
export function marketSentinelProbe(
  window: BotRiskWindow,
  regime: MarketRegimeFilter
): () => MarketSentinelSample {
  return () => {
    const snap = window.snapshot();
    const r = regime.getRegime();
    return {
      botRisk: snap.avg,
      highRiskFraction: snap.highFraction,
      regimeRiskOff: r.whaleRiskOff === true || r.regime === 'TRENDING_BEAR' || r.regime === 'EXTREME_VOLATILITY',
    };
  };
}

