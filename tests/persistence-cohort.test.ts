import { describe, it, expect } from 'vitest';
import { PersistenceCohort, type LeaderboardRow } from '../src/graph/persistence-cohort.js';

describe('PersistenceCohort (P5.1 persistent-trader filter)', () => {
  it('classifies persistent vs spike traders across windows', () => {
    const c = new PersistenceCohort();
    // Trader A: present in all 3 windows with rank <= 100 → persistent.
    const a: LeaderboardRow = { handle: 'a', rank24h: 14, rank7d: 21, rank30d: 18, source: 'fomo' };
    // Trader B: rank 1 in 24h, 431 in 7d → spike, not persistent.
    const b: LeaderboardRow = { handle: 'b', rank24h: 1, rank7d: 431, rank30d: 892, source: 'fomo' };
    c.observe(a);
    c.observe(b);
    expect(c.isPersistent('a')).toBe(true);
    expect(c.isPersistent('b')).toBe(false);
  });

  it('computes Tier A/B/C across sources (GMGN ∩ FOMO ∩ Pump)', () => {
    const c = new PersistenceCohort();
    for (const src of ['gmgn', 'fomo', 'pump']) {
      c.observe({ handle: 'triple', rank24h: 10, rank7d: 20, rank30d: 30, source: src });
    }
    for (const src of ['gmgn', 'fomo']) {
      c.observe({ handle: 'double', rank24h: 5, rank7d: 15, rank30d: 25, source: src });
    }
    c.observe({ handle: 'single', rank24h: 5, rank7d: 15, rank30d: 25, source: 'fomo' });
    expect(c.tier('triple')).toBe('C');
    expect(c.tier('double')).toBe('B');
    expect(c.tier('single')).toBe('A');
  });

  it('detects COHORT_CONVERGENCE: 3+ persistent traders same token within window', () => {
    const c = new PersistenceCohort();
    for (const src of ['gmgn', 'fomo', 'pump']) {
      c.observe({ handle: 'w1', rank24h: 1, rank7d: 2, rank30d: 3, source: src });
      c.observe({ handle: 'w2', rank24h: 4, rank7d: 5, rank30d: 6, source: src });
      c.observe({ handle: 'w3', rank24h: 7, rank7d: 8, rank30d: 9, source: src });
    }
    // 3 persistent wallets buy the same token within 3 min → convergence.
    const ev = c.checkConvergence('TOKEN', [
      { handle: 'w1', at: 1000 },
      { handle: 'w2', at: 1100 },
      { handle: 'w3', at: 1200 },
    ], 5 * 60 * 1000);
    expect(ev).not.toBeNull();
    expect(ev!.token).toBe('TOKEN');
    expect(ev!.wallets.length).toBe(3);
    // Only 2 wallets → no convergence.
    const none = c.checkConvergence('TOKEN2', [
      { handle: 'w1', at: 1000 },
      { handle: 'w2', at: 1100 },
    ], 5 * 60 * 1000);
    expect(none).toBeNull();
  });
});

describe('PersistenceCohort 6.8 — recorded surface', () => {
  const row = (handle: string, source: 'gmgn' | 'fomo' | 'pump', rank: number) => ({
    handle, source, rank24h: rank, rank7d: rank, rank30d: rank,
  });

  it('tracks tier-C count and cohort size', () => {
    const c = new PersistenceCohort();
    for (const src of ['gmgn', 'fomo', 'pump'] as const) {
      c.observe(row('tierC', src, 10)); // persistent in all 3 → tier C
    }
    c.observe(row('tierA', 'gmgn', 10)); // persistent in 1 → tier A
    c.observe(row('oneDay', 'gmgn', 10)); // present but only observe once? still tier A
    const s = c.stats();
    expect(s.cohortSize).toBe(3);
    expect(s.tierC).toBe(1);
    expect(c.tierCounts()).toEqual({ A: 2, B: 0, C: 1 });
  });

  it('records COHORT_CONVERGENCE event count', () => {
    const c = new PersistenceCohort();
    for (const src of ['gmgn', 'fomo', 'pump'] as const) c.observe(row('w1', src, 10));
    for (const src of ['gmgn', 'fomo', 'pump'] as const) c.observe(row('w2', src, 10));
    for (const src of ['gmgn', 'fomo', 'pump'] as const) c.observe(row('w3', src, 10));
    expect(c.stats().convergenceEvents).toBe(0);
    c.checkConvergence('T', [
      { handle: 'w1', at: 1000 },
      { handle: 'w2', at: 1100 },
      { handle: 'w3', at: 1200 },
    ], 5 * 60 * 1000);
    expect(c.stats().convergenceEvents).toBe(1);
  });
});
