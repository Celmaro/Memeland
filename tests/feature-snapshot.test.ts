import { describe, it, expect } from 'vitest';
import {
  buildFeatureSnapshot,
  type FeatureSnapshot,
  type ProvenancedValue,
} from '../src/features/feature-snapshot.js';

const SRC = { chain: 'base', tokenAddress: '0xabc', symbol: 'PEPE', priceUsd: 0.5, liquidityUsd: 25000, volume24hUsd: 50000 };

describe('buildFeatureSnapshot (#1 point-in-time)', () => {
  it('captures the market group with provenance (source+observedAt)', () => {
    const snap = buildFeatureSnapshot({
      candidateId: 'cand-1',
      timestamp: 1000,
      source: { name: 'dexpaprika', fetchedAt: 950 },
      market: { priceUsd: 0.5, liquidityUsd: 25000, volume24hUsd: 50000 },
      flow: { buyUsd1h: 10000, sellUsd1h: 5000 },
      security: { sellable: true },
      momentum: { change1hPct: 12 },
    });
    expect(snap.snapshotId).toBeDefined();
    expect(snap.candidateId).toBe('cand-1');
    expect(snap.timestamp).toBe(1000);
    expect(snap.market.priceUsd.value).toBe(0.5);
    expect(snap.market.priceUsd.source).toBe('dexpaprika');
    expect(snap.market.priceUsd.observedAt).toBe(950);
    expect(snap.flow.buyUsd1h).toBeDefined();
    expect(snap.security.sellable).toBeDefined();
    expect(snap.momentum.change1hPct).toBeDefined();
  });

  it('is immutable: no future timestamp can overwrite a captured field (point-in-time)', () => {
    const snap = buildFeatureSnapshot({
      candidateId: 'cand-1',
      timestamp: 1000,
      source: { name: 'dexpaprika', fetchedAt: 950 },
      market: { priceUsd: 0.5 },
    });
    // Simulate a later observation arriving — the snapshot must NOT be mutated.
    const price = snap.market.priceUsd as ProvenancedValue<number>;
    expect(price.value).toBe(0.5);
    expect(price.observedAt).toBe(950);
    // A frozen snapshot rejects writes (immutability of the point-in-time record).
    expect(Object.isFrozen(snap.market)).toBe(true);
    expect(() => {
      (snap.market as any).priceUsd = { value: 999, source: 'late', observedAt: 9999 };
    }).toThrow();
  });

  it('records dataQuality from field completeness', () => {
    const full = buildFeatureSnapshot({
      candidateId: 'c1', timestamp: 1,
      source: { name: 'a', fetchedAt: 0 },
      market: { priceUsd: 1, liquidityUsd: 2, volume24hUsd: 3 },
      flow: { buyUsd1h: 4 },
      security: { sellable: true },
      momentum: { change1hPct: 5 },
    });
    expect(full.dataQuality).toBeGreaterThanOrEqual(0);
    expect(full.dataQuality).toBeLessThanOrEqual(1);
    const empty = buildFeatureSnapshot({
      candidateId: 'c2', timestamp: 1, source: { name: 'a', fetchedAt: 0 },
    });
    expect(empty.dataQuality).toBeLessThan(full.dataQuality);
  });
});