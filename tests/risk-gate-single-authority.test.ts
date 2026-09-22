import { describe, expect, it } from 'vitest';
import { RiskEngineV2 } from '../src/orchestrator/risk-engine-v2.js';

function makeEngine(opts?: { killSwitch?: boolean }) {
  return new RiskEngineV2({
    loadKillSwitch: () => opts?.killSwitch ?? false,
    saveKillSwitch: () => {},
  });
}

/** Fake risk-manager adapter with a controllable gate. */
function fakeRiskManager(allowed: boolean, reason?: string) {
  return {
    isTradeAllowed: (amountUsd: number) => (allowed ? { allowed: true } : { allowed: false, reason: reason ?? `denied $${amountUsd}` }),
  };
}

describe('RiskEngineV2.checkExecutionAllowed (Gemini G-3 single risk authority)', () => {
  it('passes when the risk manager allows and no kill-switch is active', () => {
    const engine = makeEngine();
    const res = engine.checkExecutionAllowed(100, fakeRiskManager(true));
    expect(res.allowed).toBe(true);
    expect(res.source).toBe('risk-manager');
  });

  it('fails with source=risk-manager when the risk manager denies', () => {
    const engine = makeEngine();
    const res = engine.checkExecutionAllowed(100, fakeRiskManager(false, 'drawdown cap hit'));
    expect(res.allowed).toBe(false);
    expect(res.source).toBe('risk-manager');
    expect(res.reason).toContain('drawdown cap hit');
  });

  it('fails with source=kill-switch when the kill-switch is active, even if the risk manager allows', () => {
    const engine = makeEngine({ killSwitch: true });
    const res = engine.checkExecutionAllowed(100, fakeRiskManager(true));
    expect(res.allowed).toBe(false);
    expect(res.source).toBe('kill-switch');
  });

  it('passes the amount through to the risk manager', () => {
    const engine = makeEngine();
    let seen: number | undefined;
    engine.checkExecutionAllowed(42, { isTradeAllowed: (amountUsd) => { seen = amountUsd; return { allowed: true }; } });
    expect(seen).toBe(42);
  });
});