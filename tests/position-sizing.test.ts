import { describe, it, expect } from 'vitest';
import { sizePosition, RuleGate, cooldownGate } from '../src/orchestrator/position-sizing.js';

describe('sizePosition (Q07)', () => {
  it('collapses to the most restrictive constraint', () => {
    const r = sizePosition(10_000, { maxNotionalUsd: 2000, maxUsd: 1500, dailyLossHeadroomUsd: 5000 });
    expect(r.sizeUsd).toBe(1500);
    expect(r.constraint).toBe('maxUsd');
    const headroom = sizePosition(10_000, { maxNotionalUsd: 2000, maxUsd: 1500, dailyLossHeadroomUsd: 800 });
    expect(headroom.sizeUsd).toBe(800);
    expect(headroom.constraint).toBe('dailyLossHeadroom');
  });

  it('defaults to the RH notional cap when no explicit cap is given', () => {
    expect(sizePosition(50_000, {}).sizeUsd).toBe(2000);
  });

  it('refuses below the floor / on daily-loss halt (fail-closed)', () => {
    const belowFloor = sizePosition(80, { minUsd: 100 });
    expect(belowFloor.refused).toBe(true);
    expect(belowFloor.sizeUsd).toBe(0);
    const halted = sizePosition(500, { dailyLossHeadroomUsd: 0 });
    expect(halted.refused).toBe(true);
    expect(halted.reason).toContain('halt');
  });

  it('does not size negative / zero notional', () => {
    expect(sizePosition(-5).refused).toBe(true);
    expect(sizePosition(NaN).refused).toBe(true);
  });
});

describe('RuleGate (Q07)', () => {
  it('a single failed gate refuses execution (fail-closed)', async () => {
    const gate = new RuleGate([
      { name: 'safety', check: () => ({ state: 'ok' }) },
      { name: 'exposure', check: () => ({ state: 'fail', reason: 'over 40% chain exposure' }) },
    ]);
    const r = await gate.evaluate();
    expect(r.allowed).toBe(false);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]).toContain('exposure');
  });

  it('UNKNOWN never auto-approves', async () => {
    const gate = new RuleGate([{ name: 'health', check: () => ({ state: 'unknown' }) }]);
    expect((await gate.evaluate()).allowed).toBe(false);
  });

  it('all-ok rules allow the chain', async () => {
    const gate = new RuleGate([{ name: 'a', check: () => ({ state: 'ok' }) }, { name: 'b', check: async () => ({ state: 'ok' }) }]);
    const r = await gate.evaluate();
    expect(r.allowed).toBe(true);
    expect(r.refusals).toEqual([]);
  });

  it('cooldown halts suppress sizing until the window passes', async () => {
    const now = 1_000_000;
    const inCooldown = new RuleGate([{ name: 'cool', check: cooldownGate(now - 1000, 5000, now) }]);
    expect((await inCooldown.evaluate()).allowed).toBe(false);
    const passed = new RuleGate([{ name: 'cool', check: cooldownGate(now - 10_000, 5000, now) }]);
    expect((await passed.evaluate()).allowed).toBe(true);
    const idle = new RuleGate([{ name: 'cool', check: cooldownGate(null, 5000, now) }]);
    expect((await idle.evaluate()).allowed).toBe(true);
  });
});
