import { describe, it, expect } from 'vitest';
import { RiskEngineV2 } from '../src/orchestrator/risk-engine-v2.js';
import type { PositionRiskCheck } from '../src/orchestrator/risk-engine-v2.js';

describe('PR9 risk profile shadow gates', () => {
  it('exposes veto and downgrade reasons without changing the enforced decision', () => {
    const engine = new RiskEngineV2();
    const proposed: PositionRiskCheck = {
      assetSymbol: 'MEME',
      chain: 'eth',
      usdValue: 5000,
      riskProfile: {
        confidence: 60,
        maxPositionUsd: 1000,
        dailyLossLimitUsd: 1000,
        currentDailyLossUsd: 700,
        bankrollUsd: 10_000,
        kelly: { winProbability: 0.6, winLossRatio: 1, fraction: 0.25 },
        entryPriceUsd: 100,
        atr: 5,
        atrStopLossMultiplier: 2,
        atrTakeProfitMultiplier: 3,
        highestPriceUsd: 180,
        trailingStopActivateProfitPct: 50,
        trailingStopPercent: 15,
      },
    };

    const result = engine.evaluateTradeRisk(proposed, 60_000, [], 0);

    // Existing enforcement path stays untouched: legacy volatility sizing is
    // the only recommendation and it still permits the trade.
    expect(result.allowed).toBe(true);
    expect(result.recommendedPositionSizeUsd).toBe(5000);

    expect(result.shadow).toBeDefined();
    expect(result.shadow!.vetoes.some((r) => r.includes('confidence'))).toBe(true);
    expect(result.shadow!.downgrades.some((r) => r.includes('max-position'))).toBe(true);
    expect(result.shadow!.downgrades.some((r) => r.includes('daily-loss'))).toBe(true);
    expect(result.shadow!.downgrades.some((r) => r.includes('kelly'))).toBe(true);
    expect(result.shadow!.recommendedPositionSizeUsd).toBeLessThanOrEqual(1000);
  });

  it('carries the current decision and the delta for shadow comparison', () => {
    const engine = new RiskEngineV2();
    const result = engine.evaluateTradeRisk(
      {
        assetSymbol: 'TEST',
        chain: 'sol',
        usdValue: 2000,
        riskProfile: { confidence: 90, maxPositionUsd: 800, currentDailyLossUsd: 0, dailyLossLimitUsd: 1000 },
      },
      30_000,
      [],
      0
    );

    expect(result.shadow?.current).toMatchObject({ allowed: true, recommendedPositionSizeUsd: 2000 });
    expect(result.shadow?.recommendedPositionSizeUsd).toBe(800);
    expect(result.shadow?.delta?.sizeChangeUsd).toBe(-1200);
    expect(result.shadow?.delta?.allowedChanged).toBe(false);
  });

  it('includes next-execution ATR stops and activation-gated trailing stops', () => {
    const engine = new RiskEngineV2();
    const result = engine.evaluateShadowRisk(
      {
        assetSymbol: 'ATR',
        chain: 'eth',
        usdValue: 1000,
        riskProfile: {
          entryPriceUsd: 100,
          atr: 5,
          highestPriceUsd: 180,
          trailingStopActivateProfitPct: 50,
          trailingStopPercent: 15,
        },
      },
      10_000,
      [],
      0
    );

    expect(result.exitPlan?.stopLossUsd).toBeCloseTo(90);
    expect(result.exitPlan?.takeProfitUsd).toBeCloseTo(115);
    expect(result.exitPlan?.trailingStopUsd).toBeCloseTo(153);
  });
});
