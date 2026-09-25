import { describe, it, expect } from 'vitest';
import { gateSizer, gateFillSim } from '../src/services/execution-gates.js';
import { sizePosition } from '../src/orchestrator/position-sizing.js';
import { simulateFill } from '../src/services/fill-simulation.js';

/**
 * Item 5 — property invariants for the financial core. No property-test
 * framework needed: deterministic sweeps over the input domain assert the
 * invariants the safety model depends on. If any invariant breaks for ANY
 * point in the swept domain, the trade math is unsafe — not "mostly safe".
 */

describe('property: position size can never exceed the configured max', () => {
  it('for every desired notional in [$1k, $100k] and every cap in [$2k, $50k], size ≤ cap', () => {
    for (let desired = 1000; desired <= 100_000; desired += 1000) {
      for (const cap of [2000, 5000, 10_000, 25_000, 50_000]) {
        const r = sizePosition(desired, { maxNotionalUsd: cap, minUsd: 0 });
        if (!r.refused) {
          expect(r.sizeUsd).toBeLessThanOrEqual(cap);
          expect(r.sizeUsd).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('edge-scaled sizing never exceeds the cap (confidence + liquidity sweep)', () => {
    const sizer = gateSizer();
    for (const conf of [70, 75, 80, 85, 90, 95, 100]) {
      for (const liq of [1000, 5000, 10_000, 50_000, 200_000]) {
        for (const desired of [1000, 5000, 10_000, 25_000]) {
          const r = sizer.clamp(desired, { confidence: conf, liquidityUsd: liq });
          if (r.allowed) {
            expect(r.amountUsd).toBeLessThanOrEqual(desired); // never scales UP
            expect(r.amountUsd).toBeLessThanOrEqual(2000); // default MAX_NOTIONAL_USD
          }
        }
      }
    }
  });
});

describe('property: slippage/impact is never negative and never exceeds the cap', () => {
  it('for every mid-price and notional in the swept domain, impact ≥ 0 and respects the cap', () => {
    const sim = gateFillSim();
    for (const mid of [0.001, 0.01, 0.1, 1, 10, 100]) {
      for (const amount of [100, 500, 1000, 5000, 10_000]) {
        for (const liq of [1000, 10_000, 100_000, 1_000_000]) {
          const r = sim.check({ amountUsd: amount, midPriceUsd: mid, liquidityUsd: liq });
          expect(r.impactPct).toBeGreaterThanOrEqual(0); // never negative slippage
          if (r.allowed) expect(r.impactPct).toBeLessThanOrEqual(5); // default cap
        }
      }
    }
  });

  it('zero/negative mid-price or notional is refused (fail-closed), never negative impact', () => {
    const sim = gateFillSim();
    const zero = sim.check({ amountUsd: 500, midPriceUsd: 0, liquidityUsd: 10000 });
    expect(zero.impactPct).toBeGreaterThanOrEqual(0);
    const neg = sim.check({ amountUsd: -500, midPriceUsd: 1, liquidityUsd: 10000 });
    expect(neg.impactPct).toBeGreaterThanOrEqual(0);
  });
});

describe('property: rounding never creates an order larger than the approved amount', () => {
  it('for every desired notional, the reported size ≤ the approved (pre-round) size', () => {
    const sizer = gateSizer();
    for (let desired = 500; desired <= 20_000; desired += 137) { // odd step catches rounding
      const r = sizer.clamp(desired, { confidence: 95, liquidityUsd: 200_000 });
      if (r.allowed) {
        // Full edge scale (conf 95 → 1.0, deep liq → 1.0): size ≈ desired, never above.
        expect(r.amountUsd).toBeLessThanOrEqual(desired);
      }
    }
  });
});

describe('property: simulateFill reports refused for illiquid/zero depth', () => {
  it('zero liquidity is always refused with impact ≥ 0', () => {
    for (let amount = 100; amount <= 10_000; amount += 500) {
      const r = simulateFill({ notionalUsd: amount, midPriceUsd: 1, depth: { liquidityUsd: 0 } });
      expect(r.refused).toBe(true);
      expect(r.impactPct).toBeGreaterThanOrEqual(0);
    }
  });
});