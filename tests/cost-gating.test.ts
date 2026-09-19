import { describe, it, expect } from 'vitest';
import { CostGate, crossMarketHeadroom } from '../src/services/cost-gating.js';

describe('CostGate (Q13)', () => {
  it('blocks further auto-execution when the cumulative cost cap is exceeded', () => {
    const gate = new CostGate(100);
    expect(gate.canSubmit(60)).toBe(true);
    expect(gate.recordFill(60)).toBe(true);
    expect(gate.canSubmit(50)).toBe(false); // 60+50 > 100
    expect(gate.recordFill(50)).toBe(false);
    expect(gate.spentUsd).toBe(60);
  });

  it('reset is explicit and restores headroom', () => {
    const gate = new CostGate(100);
    gate.recordFill(100);
    expect(gate.canSubmit(1)).toBe(false);
    gate.reset();
    expect(gate.spentUsd).toBe(0);
    expect(gate.canSubmit(90)).toBe(true);
  });

  it('edge-on-cap is accepted; over-cap rejected', () => {
    const gate = new CostGate(50);
    expect(gate.canSubmit(50)).toBe(true);
    expect(gate.recordFill(50)).toBe(true);
    expect(gate.canSubmit(0.01)).toBe(false);
  });
});

describe('crossMarketHeadroom (Q13)', () => {
  it('correlated exposures sum against a shared cap', () => {
    const m = crossMarketHeadroom([2000, 1500, 500], 5000);
    expect(m.totalUsd).toBe(4000);
    expect(m.headroomUsd).toBe(1000);
    expect(m.overCap).toBe(false);
    const over = crossMarketHeadroom([3000, 3000], 5000);
    expect(over.overCap).toBe(true);
    expect(over.headroomUsd).toBe(0);
  });

  it('invalid exposures are ignored (never count toward the cap)', () => {
    const m = crossMarketHeadroom([2000, NaN, -5, undefined as unknown as number], 3000);
    expect(m.totalUsd).toBe(2000);
    expect(m.headroomUsd).toBe(1000);
  });
});
