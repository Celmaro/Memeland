import { describe, it, expect } from 'vitest';
import { RiskEngineV2 } from '../src/orchestrator/risk-engine-v2.js';

describe('RiskEngineV2 shadow-mode wiring', () => {
  it('keeps the legacy kill-switch veto at the top of the decision', () => {
    const engine = new RiskEngineV2();
    engine.activateKillSwitch('test veto still wins');
    const result = engine.evaluateTradeRisk({ assetSymbol: 'MEME', chain: 'eth', usdValue: 100 }, 10_000, [], 0);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Kill-Switch active');
    expect(result.shadow?.vetoes.some((r) => r.toLowerCase().includes('kill-switch'))).toBe(true);
  });

  it('reports a delta when the shadow size is smaller than the current recommendation', () => {
    const engine = new RiskEngineV2();
    const result = engine.evaluateTradeRisk(
      {
        assetSymbol: 'CAPS',
        chain: 'eth',
        usdValue: 3000,
        riskProfile: { confidence: 95, maxPositionUsd: 1200 },
      },
      50_000,
      [],
      0
    );

    expect(result.allowed).toBe(true);
    expect(result.shadow?.downgrades.some((r) => r.includes('max-position'))).toBe(true);
    expect(result.shadow?.recommendedPositionSizeUsd).toBe(1200);
    expect(result.shadow?.delta?.sizeChangeUsd).toBe(-1800);
  });
});
