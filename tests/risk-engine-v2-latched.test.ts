import { describe, it, expect } from 'vitest';
import { RiskEngineV2 } from '../src/orchestrator/risk-engine-v2.js';

describe('RiskEngineV2 latched kill-switch', () => {
  it('restores engaged state across a restart over a shared store', () => {
    const store: { engaged: boolean } = { engaged: false };
    const persistence = {
      loadKillSwitch: () => store.engaged,
      saveKillSwitch: (v: boolean) => {
        store.engaged = v;
      },
    };

    const engine1 = new RiskEngineV2(persistence);
    engine1.activateKillSwitch('latched across restart');
    expect(store.engaged).toBe(true);

    const engine2 = new RiskEngineV2(persistence);
    expect(engine2.checkKillSwitchStatus()).toBe(true);

    const result = engine2.evaluateTradeRisk(
      { assetSymbol: 'TEST', chain: 'sol', usdValue: 100 },
      10000,
      [],
      0
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Kill-Switch active');
  });

  it('resetKillSwitch clears the latched state and persists false', () => {
    const store: { engaged: boolean } = { engaged: false };
    const persistence = {
      loadKillSwitch: () => store.engaged,
      saveKillSwitch: (v: boolean) => {
        store.engaged = v;
      },
    };

    const engine1 = new RiskEngineV2(persistence);
    engine1.activateKillSwitch('reason');
    const engine2 = new RiskEngineV2(persistence);
    engine2.resetKillSwitch();

    expect(store.engaged).toBe(false);
    expect(engine2.checkKillSwitchStatus()).toBe(false);

    const engine3 = new RiskEngineV2(persistence);
    expect(engine3.checkKillSwitchStatus()).toBe(false);
  });

  it('default path without a loader is not latched', () => {
    const engine1 = new RiskEngineV2();
    engine1.activateKillSwitch('not persisted');

    const engine2 = new RiskEngineV2();
    expect(engine2.checkKillSwitchStatus()).toBe(false);
  });
});
