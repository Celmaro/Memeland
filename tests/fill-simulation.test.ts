import { describe, it, expect } from 'vitest';
import { simulateFill, PaperFillBroker } from '../src/services/fill-simulation.js';

describe('simulateFill (Q08)', () => {
  it('larger notional -> larger impact and worse fill, monotonically', () => {
    const small = simulateFill({ notionalUsd: 100, midPriceUsd: 1, depth: { liquidityUsd: 10_000 } });
    const large = simulateFill({ notionalUsd: 5000, midPriceUsd: 1, depth: { liquidityUsd: 10_000 } });
    expect(large.impactPct).toBeGreaterThan(small.impactPct);
    expect(large.fillPriceUsd).toBeGreaterThan(small.fillPriceUsd);
    expect(small.impactPct).toBe(1);
    expect(large.impactPct).toBe(50);
  });

  it('zero/illiquid depth refuses (fail-closed, not best-effort)', () => {
    const zero = simulateFill({ notionalUsd: 100, midPriceUsd: 1, depth: { liquidityUsd: 0 } });
    expect(zero.refused).toBe(true);
    expect(zero.reason).toContain('depth');
    const missing = simulateFill({ notionalUsd: 100, midPriceUsd: 1, depth: {} });
    expect(missing.refused).toBe(true);
  });

  it('non-positive notional refuses', () => {
    expect(simulateFill({ notionalUsd: 0, midPriceUsd: 1, depth: { liquidityUsd: 1000 } }).refused).toBe(true);
  });
});

describe('PaperFillBroker (Q08)', () => {
  it('records slip vs. mid and refuses when depth is missing', async () => {
    const broker = new PaperFillBroker(() => 1000);
    const ok = await broker.execute({ token: 'T', chainId: 4663, notionalUsd: 100, midPriceUsd: 2, depth: { liquidityUsd: 1000 } });
    expect(ok.accepted).toBe(true);
    expect(ok.fill!.slipPct).toBe(10);
    expect(ok.fill!.fillPriceUsd).toBe(2.2);
    expect(ok.fill!.simulated).toBe(true);
    const bad = await broker.execute({ token: 'T2', chainId: 56, notionalUsd: 100, midPriceUsd: 2, depth: {} });
    expect(bad.accepted).toBe(false);
    expect(broker.log).toHaveLength(1);
  });

  it('never touches a live executor (append-only paper log, isolated)', async () => {
    const broker = new PaperFillBroker(() => 2000);
    await broker.execute({ token: 'A', chainId: 4663, notionalUsd: 50, midPriceUsd: 1, depth: { liquidityUsd: 5000 } });
    await broker.execute({ token: 'B', chainId: 8453, notionalUsd: 50, midPriceUsd: 1, depth: { liquidityUsd: 5000 } });
    expect(broker.log.map((f) => f.token)).toEqual(['A', 'B']);
    expect(broker.log[0]!.timestamp).toBe(2000);
  });
});
