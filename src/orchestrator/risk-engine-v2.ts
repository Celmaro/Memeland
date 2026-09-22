/**
 * Opencatz AI - Advanced 9-Lives Risk Engine & Circuit Breaker (RiskEngineV2)
 * Handles per-asset/chain exposure caps, correlation checks, volatility sizing,
 * real-time kill-switch, and PR9 shadow-mode risk-profile gates.
 *
 * Shadow mode is intentionally log-only: the legacy enforcement path returns
 * the same answers as before while the new gates are reported alongside it.
 */

import {
  fractionalKellySize,
  dailyLossCapSize,
  maxPositionCapSize,
  confidenceScaledSize,
  atrStopLoss,
  atrTakeProfit,
  trailingStopPrice,
} from './position-sizing.js';

export interface KellyInput {
  winProbability: number;
  winLossRatio: number;
  fraction?: number;
}

export interface RiskProfile {
  confidence?: number;
  dailyLossLimitUsd?: number;
  currentDailyLossUsd?: number;
  maxPositionUsd?: number;
  bankrollUsd?: number;
  kelly?: KellyInput;
  entryPriceUsd?: number;
  atr?: number;
  atrStopLossMultiplier?: number;
  atrTakeProfitMultiplier?: number;
  highestPriceUsd?: number;
  trailingStopActivateProfitPct?: number;
  trailingStopPercent?: number;
}

export interface PositionRiskCheck {
  assetSymbol: string;
  chain: string;
  usdValue: number;
  tags?: string[]; // e.g. ['meme', 'ai', 'robinhood']
  volatilityAtr?: number;
  riskProfile?: RiskProfile;
}

export interface RiskEngineConfig {
  maxPortfolioDrawdownPercent: number; // default 5%
  maxSingleAssetExposurePercent: number; // default 10%
  maxSingleChainExposurePercent: number; // default 40%
  maxCorrelatedPositionsCount: number; // default 3
  maxConsecutiveLossesBeforeKill: number; // default 3
  killSwitchCooldownMinutes: number; // default 60
  maxPositionUsd?: number;
  dailyLossLimitUsd?: number;
  minConfidence?: number;
  confidenceMinScale?: number;
  confidenceMaxScale?: number;
  kellyFraction?: number;
  atrStopLossMultiplier?: number;
  atrTakeProfitMultiplier?: number;
  trailingStopActivateProfitPct?: number;
  trailingStopPercent?: number;
  shadowModeUntil?: number;
}

export interface ShadowRiskEvaluation {
  allowed: boolean;
  reason?: string;
  recommendedPositionSizeUsd?: number;
  vetoes: string[];
  downgrades: string[];
  constraints: string[];
  current: {
    allowed: boolean;
    recommendedPositionSizeUsd?: number;
    reason?: string;
  };
  delta?: {
    allowedChanged: boolean;
    sizeChangeUsd: number;
  };
  exitPlan?: {
    stopLossUsd?: number;
    takeProfitUsd?: number;
    trailingStopUsd?: number | null;
  };
}

export interface RiskEvaluationResult {
  allowed: boolean;
  reason?: string;
  recommendedPositionSizeUsd?: number;
  shadow?: ShadowRiskEvaluation;
}

export interface RiskEngineV2Options extends Partial<RiskEngineConfig> {
  loadKillSwitch?: () => boolean;
  saveKillSwitch?: (v: boolean) => void;
}

export const SHADOW_MODE_DAYS = 7;
const SHADOW_MODE_DAYS_MS = SHADOW_MODE_DAYS * 24 * 60 * 60 * 1000;

export class RiskEngineV2 {
  private config: RiskEngineConfig;
  private isKillSwitchActive = false;
  private killSwitchActivatedAt: number | null = null;
  private consecutiveLossesCount = 0;
  private loadKillSwitch: () => boolean;
  private saveKillSwitch: (v: boolean) => void;

  constructor(options: RiskEngineV2Options = {}) {
    const { loadKillSwitch, saveKillSwitch, ...config } = options;
    this.config = {
      maxPortfolioDrawdownPercent: 50, // Updated to 50% max daily drawdown
      maxSingleAssetExposurePercent: 10,
      maxSingleChainExposurePercent: 40,
      maxCorrelatedPositionsCount: 3,
      maxConsecutiveLossesBeforeKill: 5,
      killSwitchCooldownMinutes: 60,
      maxPositionUsd: 2000,
      dailyLossLimitUsd: 500,
      minConfidence: 80,
      confidenceMinScale: 0.5,
      confidenceMaxScale: 1.5,
      kellyFraction: 0.25,
      atrStopLossMultiplier: 2,
      atrTakeProfitMultiplier: 3,
      trailingStopActivateProfitPct: 50,
      trailingStopPercent: 15,
      shadowModeUntil: Date.now() + SHADOW_MODE_DAYS_MS,
      ...config,
    };
    this.loadKillSwitch = loadKillSwitch ?? (() => false);
    this.saveKillSwitch = saveKillSwitch ?? (() => {});
    if (this.loadKillSwitch()) {
      this.isKillSwitchActive = true;
    }
  }

/**
  /**
   * Single portfolio authority for the execution path (Gemini G-3 fix): one
   * gate consults the risk-manager limits FIRST, then the kill-switch -
   * preserving the exact precedence the AUTO path used to apply across two
   * separate calls, so there is one source of truth for "may this execution
   * proceed". RiskManager remains as the exposure/drawdown adapter; its
   * limits are consulted here rather than by callers directly.
   */
  public checkExecutionAllowed(
    amountUsd: number,
    rm: { isTradeAllowed(amountUsd: number): { allowed: boolean; reason?: string } },
  ): { allowed: boolean; reason?: string; source: 'risk-manager' | 'kill-switch' } {
    const portfolio = rm.isTradeAllowed(amountUsd);
    if (!portfolio.allowed) return { allowed: false, reason: portfolio.reason, source: 'risk-manager' };
    if (this.checkKillSwitchStatus()) {
      return { allowed: false, reason: 'emergency kill-switch active', source: 'kill-switch' };
    }
    return { allowed: true, source: 'risk-manager' };
  }

  /**
   * Evaluate a proposed new position entry against multi-layer risk policies.
   * The existing enforcement path is unchanged; the PR9 gates run in shadow
   * mode and are exposed on `result.shadow`.
   */
  public evaluateTradeRisk(
    proposed: PositionRiskCheck,
    portfolioTotalUsd: number,
    existingPositions: PositionRiskCheck[],
    currentDrawdownPercent: number,
  ): RiskEvaluationResult {
    const current = this.evaluateLegacyRisk(proposed, portfolioTotalUsd, existingPositions, currentDrawdownPercent);
    const shadow = this.evaluateShadowRisk(proposed, portfolioTotalUsd, existingPositions, currentDrawdownPercent, current);
    this.logShadowDelta(current, shadow);
    return { ...current, shadow };
  }

  /**
   * Shadow evaluation of the same proposal with the new risk-profile gates.
   * Callers can inspect the delta without changing the live decision.
   */
  public evaluateShadowRisk(
    proposed: PositionRiskCheck,
    portfolioTotalUsd: number,
    existingPositions: PositionRiskCheck[],
    currentDrawdownPercent: number,
    current?: RiskEvaluationResult
  ): ShadowRiskEvaluation {
    const currentResult = current ?? this.evaluateLegacyRisk(proposed, portfolioTotalUsd, existingPositions, currentDrawdownPercent);
    const currentSize = currentResult.recommendedPositionSizeUsd ?? proposed.usdValue;
    const shadow: ShadowRiskEvaluation = {
      allowed: currentResult.allowed,
      reason: currentResult.reason,
      recommendedPositionSizeUsd: currentResult.recommendedPositionSizeUsd,
      vetoes: [],
      downgrades: [],
      constraints: [],
      current: {
        allowed: currentResult.allowed,
        recommendedPositionSizeUsd: currentResult.recommendedPositionSizeUsd,
        reason: currentResult.reason,
      },
    };

    let shadowAllowed = currentResult.allowed;
    let shadowSize = currentSize;

    if (!currentResult.allowed) {
      shadow.vetoes.push(`current decision veto (${currentResult.reason || 'denied'})`);
    }

    const profile = proposed.riskProfile;
    if (profile) {
      if (typeof profile.confidence === 'number' && typeof this.config.minConfidence === 'number') {
        if (profile.confidence < this.config.minConfidence) {
          shadowAllowed = false;
          shadow.vetoes.push(`confidence ${profile.confidence} below minimum ${this.config.minConfidence}`);
          shadow.constraints.push('confidence');
        } else {
          const scaled = confidenceScaledSize(
            proposed.usdValue,
            profile.confidence,
            this.config.confidenceMinScale,
            this.config.confidenceMaxScale
          );
          if (scaled < proposed.usdValue) {
            shadow.downgrades.push(`confidence-scaling caps size to $${scaled}`);
            shadow.constraints.push('confidence');
          }
          shadowSize = Math.min(shadowSize, scaled);
        }
      }

      if (typeof profile.dailyLossLimitUsd === 'number') {
        shadow.constraints.push('dailyLoss');
        const capped = dailyLossCapSize(proposed.usdValue, profile.dailyLossLimitUsd, profile.currentDailyLossUsd ?? 0);
        if (capped <= 0) {
          shadowAllowed = false;
          shadow.vetoes.push(`daily-loss cap exhausted (${profile.currentDailyLossUsd ?? 0} >= ${profile.dailyLossLimitUsd})`);
        } else if (capped < proposed.usdValue) {
          shadow.downgrades.push(`daily-loss cap limits size to $${capped}`);
          shadowSize = Math.min(shadowSize, capped);
        }
      }

      if (typeof profile.maxPositionUsd === 'number') {
        shadow.constraints.push('maxPosition');
        const capped = maxPositionCapSize(proposed.usdValue, profile.maxPositionUsd);
        if (capped <= 0) {
          shadowAllowed = false;
          shadow.vetoes.push(`max-position cap blocks sizing (${profile.maxPositionUsd})`);
        } else if (capped < proposed.usdValue) {
          shadow.downgrades.push(`max-position cap limits size to $${capped}`);
          shadowSize = Math.min(shadowSize, capped);
        }
      }

      if (profile.kelly && typeof profile.bankrollUsd === 'number') {
        shadow.constraints.push('kelly');
        const kellySize = fractionalKellySize(
          profile.bankrollUsd,
          profile.kelly.winProbability,
          profile.kelly.winLossRatio,
          profile.kelly.fraction ?? this.config.kellyFraction
        );
        if (kellySize <= 0) {
          shadowAllowed = false;
          shadow.vetoes.push(`kelly sizing produced non-positive size`);
        } else if (kellySize < proposed.usdValue) {
          shadow.downgrades.push(`kelly sizing limits size to $${kellySize}`);
          shadowSize = Math.min(shadowSize, kellySize);
        }
      }

      shadow.exitPlan = this.shadowExitPlan(profile);
    }

    if (shadowAllowed !== currentResult.allowed) {
      shadow.reason = shadow.vetoes.length > 0 ? `shadow veto: ${shadow.vetoes.join('; ')}` : `shadow ${shadowAllowed ? 'allowed' : 'denied'}`;
    }

    if (shadowSize !== currentSize) {
      shadow.recommendedPositionSizeUsd = shadowSize;
    }

    shadow.delta = {
      allowedChanged: shadowAllowed !== currentResult.allowed,
      sizeChangeUsd: shadowSize - currentSize,
    };
    shadow.allowed = shadowAllowed;
    return shadow;
  }

  /**
   * Record trade completion result to update consecutive loss counter
   */
  public recordTradeOutcome(isProfit: boolean): void {
    if (isProfit) {
      this.consecutiveLossesCount = 0;
    } else {
      this.consecutiveLossesCount++;
      if (this.consecutiveLossesCount >= this.config.maxConsecutiveLossesBeforeKill) {
        this.activateKillSwitch(`${this.consecutiveLossesCount} consecutive trade losses recorded.`);
      }
    }
  }

  /**
   * Manually or automatically activate the Kill Switch
   */
  public activateKillSwitch(reason: string): void {
    this.isKillSwitchActive = true;
    this.killSwitchActivatedAt = Date.now();
    this.saveKillSwitch(true);
    console.error(`🚨 OPENCATZ 9-LIVES RISK ENGINE: Emergency Kill Switch Activated! Reason: ${reason}`);
  }

  /**
   * Reset Kill Switch status
   */
  public resetKillSwitch(): void {
    this.isKillSwitchActive = false;
    this.killSwitchActivatedAt = null;
    this.consecutiveLossesCount = 0;
    this.saveKillSwitch(false);
    console.log(`✅ OPENCATZ 9-LIVES RISK ENGINE: Kill Switch manually reset.`);
  }

  /**
   * Check if Kill Switch is active, handling auto-cooldown expiration
   */
  public checkKillSwitchStatus(): boolean {
    if (!this.isKillSwitchActive) return false;

    if (this.killSwitchActivatedAt) {
      const elapsedMinutes = (Date.now() - this.killSwitchActivatedAt) / (1000 * 60);
      if (elapsedMinutes >= this.config.killSwitchCooldownMinutes) {
        this.resetKillSwitch();
        return false;
      }
    }
    return true;
  }

  private evaluateLegacyRisk(
    proposed: PositionRiskCheck,
    portfolioTotalUsd: number,
    existingPositions: PositionRiskCheck[],
    currentDrawdownPercent: number
  ): RiskEvaluationResult {
    // 1. Check Circuit Breaker Kill-Switch Status
    if (this.checkKillSwitchStatus()) {
      return {
        allowed: false,
        reason: '⛔ Emergency Kill-Switch active due to repeated loss or severe drawdown.',
      };
    }

    // 2. Global Portfolio Drawdown Check
    if (currentDrawdownPercent >= this.config.maxPortfolioDrawdownPercent) {
      this.activateKillSwitch(`Global portfolio drawdown limit exceeded (${currentDrawdownPercent.toFixed(1)}% >= ${this.config.maxPortfolioDrawdownPercent}%)`);
      return {
        allowed: false,
        reason: `⛔ Portfolio drawdown threshold breached (${currentDrawdownPercent.toFixed(1)}%). Trading locked.`,
      };
    }

    // 3. Single Asset Exposure Cap Check
    const existingAssetUsd = existingPositions
      .filter((p) => p.assetSymbol.toUpperCase() === proposed.assetSymbol.toUpperCase())
      .reduce((sum, p) => sum + p.usdValue, 0);

    const totalAssetExposurePercent = ((existingAssetUsd + proposed.usdValue) / Math.max(portfolioTotalUsd, 1)) * 100;
    if (totalAssetExposurePercent > this.config.maxSingleAssetExposurePercent) {
      const maxAllowedUsd = (portfolioTotalUsd * this.config.maxSingleAssetExposurePercent) / 100 - existingAssetUsd;
      return {
        allowed: false,
        reason: `⚠️ Exposure cap for ${proposed.assetSymbol} exceeded (${totalAssetExposurePercent.toFixed(1)}% > ${this.config.maxSingleAssetExposurePercent}% max).`,
        recommendedPositionSizeUsd: Math.max(0, maxAllowedUsd),
      };
    }

    // 4. Single Chain Exposure Cap Check
    const existingChainUsd = existingPositions
      .filter((p) => p.chain.toLowerCase() === proposed.chain.toLowerCase())
      .reduce((sum, p) => sum + p.usdValue, 0);

    const totalChainExposurePercent = ((existingChainUsd + proposed.usdValue) / Math.max(portfolioTotalUsd, 1)) * 100;
    if (totalChainExposurePercent > this.config.maxSingleChainExposurePercent) {
      return {
        allowed: false,
        reason: `⚠️ Chain exposure cap for ${proposed.chain} exceeded (${totalChainExposurePercent.toFixed(1)}% > ${this.config.maxSingleChainExposurePercent}% max).`,
      };
    }

    // 5. Narrative / Correlation Risk Check
    if (proposed.tags && proposed.tags.length > 0) {
      const correlatedCount = existingPositions.filter((pos) => {
        if (!pos.tags) return false;
        return pos.tags.some((tag) => proposed.tags?.includes(tag));
      }).length;

      if (correlatedCount >= this.config.maxCorrelatedPositionsCount) {
        return {
          allowed: false,
          reason: `⚠️ Correlation risk cap hit (${correlatedCount} correlated positions open in tags: [${proposed.tags.join(', ')}]).`,
        };
      }
    }

    // 6. Volatility-Adjusted Sizing Calculation (Kelly / ATR sizing)
    let recommendedUsd = proposed.usdValue;
    if (proposed.volatilityAtr && proposed.volatilityAtr > 0) {
      // Scale size inversely to ATR volatility
      const baseAtr = 0.05; // 5% baseline ATR
      const volMultiplier = Math.min(2.0, Math.max(0.25, baseAtr / proposed.volatilityAtr));
      recommendedUsd = Math.round(proposed.usdValue * volMultiplier);
    }

    return {
      allowed: true,
      recommendedPositionSizeUsd: recommendedUsd,
    };
  }

  private shadowExitPlan(profile: RiskProfile): ShadowRiskEvaluation['exitPlan'] {
    const plan: NonNullable<ShadowRiskEvaluation['exitPlan']> = {};
    if (typeof profile.entryPriceUsd === 'number' && typeof profile.atr === 'number') {
      plan.stopLossUsd = atrStopLoss(
        profile.entryPriceUsd,
        profile.atr,
        profile.atrStopLossMultiplier ?? this.config.atrStopLossMultiplier
      );
      plan.takeProfitUsd = atrTakeProfit(
        profile.entryPriceUsd,
        profile.atr,
        profile.atrTakeProfitMultiplier ?? this.config.atrTakeProfitMultiplier
      );
    }
    if (typeof profile.entryPriceUsd === 'number' && typeof profile.highestPriceUsd === 'number') {
      plan.trailingStopUsd = trailingStopPrice(
        profile.entryPriceUsd,
        profile.highestPriceUsd,
        profile.trailingStopPercent ?? this.config.trailingStopPercent ?? 15,
        profile.trailingStopActivateProfitPct ?? this.config.trailingStopActivateProfitPct ?? 50
      );
    }
    return Object.keys(plan).length > 0 ? plan : undefined;
  }

  private logShadowDelta(current: RiskEvaluationResult, shadow: ShadowRiskEvaluation): void {
    const sizeDelta = shadow.delta?.sizeChangeUsd ?? 0;
    const state = shadow.allowed === current.allowed ? 'MATCH' : 'DIFF';
    console.warn(
      `[RISK SHADOW] ${state} current=${current.allowed} shadow=${shadow.allowed} delta=${
        sizeDelta >= 0 ? '+' : ''
      }${sizeDelta} vetoes=${shadow.vetoes.length} downgrades=${shadow.downgrades.length}`
    );
  }
}

export const globalRiskEngineV2 = new RiskEngineV2();
