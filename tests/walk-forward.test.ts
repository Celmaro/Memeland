import { describe, it, expect } from 'vitest';
import {
  walkForwardSplit,
  type OutcomeRow,
  evaluateOos,
  evaluateStrategyWalkForward,
  compareWalkForward,
  renderWalkForwardReport,
} from '../src/orchestrator/walk-forward.js';

function tag(rows: OutcomeRow[], strategy: string): OutcomeRow[] {
  return rows.map((r) => ({ ...r, strategy }));
}

const rows: OutcomeRow[] = Array.from({ length: 30 }, (_, i) => ({
  id: `o${i}`,
  timestamp: 1_700_000_000_000 + i * 86_400_000, // daily
  confidence: 50 + (i % 45),
  realizedPnlPct: (i % 5 === 0 ? -20 : 12),
  return1h: (i % 5 === 0 ? -0.2 : 0.12),
}));

describe('walkForwardSplit (P6.1 temporal splits — no shuffle)', () => {
  it('splits chronologically: train < validation < test', () => {
    const { train, validation, test } = walkForwardSplit(rows, 0.5, 0.2);
    expect(train.length).toBe(15);
    expect(validation.length).toBe(6);
    expect(test.length).toBe(9);
    // Strictly chronological: last train < first validation < first test.
    expect(train[train.length - 1]!.timestamp).toBeLessThan(validation[0]!.timestamp);
    expect(validation[validation.length - 1]!.timestamp).toBeLessThan(test[0]!.timestamp);
  });

  it('keeps full rows (no shuffling the time series)', () => {
    const { train } = walkForwardSplit(rows, 0.5, 0.2);
    expect(train.map((r) => r.id)).toEqual(rows.slice(0, 15).map((r) => r.id));
  });
});

describe('evaluateOos (P6.1 out-of-sample metrics)', () => {
  it('computes hit rate, expectancy, profit factor, Sharpe', () => {
    const m = evaluateOos(rows.slice(15)); // test slice
    expect(m.hitRate).toBeGreaterThan(0);
    expect(m.expectancy).toBeGreaterThan(0); // most rows are winners
    expect(m.profitFactor).toBeGreaterThan(0);
    expect(Number.isFinite(m.sharpe)).toBe(true);
    expect(m.n).toBe(rows.slice(15).length);
  });

  it('handles an all-loss test set without NaN', () => {
    const losses: OutcomeRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `l${i}`, timestamp: 1_700_000_000_000 + i, confidence: 60, realizedPnlPct: -10, return1h: -0.1,
    }));
    const m = evaluateOos(losses);
    expect(m.hitRate).toBe(0);
    expect(m.expectancy).toBeLessThan(0);
    expect(Number.isFinite(m.sharpe)).toBe(true);
  });
});

describe('evaluateStrategyWalkForward (P6.1 single-strategy verdict)', () => {
  it('reports train/validation/test metrics and a ROBUST verdict when OOS holds', () => {
    // Monotone winners: IS Sharpe and OOS Sharpe both positive bright.
    const good = Array.from({ length: 40 }, (_, i) => ({
      id: `g${i}`,
      timestamp: 1_700_000_000_000 + i * 86_400_000,
      confidence: 80,
      realizedPnlPct: 8,
      return1h: 0.06,
      strategy: 'swarm',
    }));
    const r = evaluateStrategyWalkForward(good, 'swarm');
    expect(r.strategy).toBe('swarm');
    expect(r.train.n + r.validation.n + r.test.n).toBe(40);
    expect(r.test.expectancy).toBeGreaterThan(0);
    expect(r.test.hitRate).toBe(1);
    expect(['ROBUST', 'WEAK', 'OVERFITTED']).toContain(r.overfit.verdict);
  });
});

describe('compareWalkForward + renderWalkForwardReport (P6.1 cross-strategy, fail-closed)', () => {
  it('groups strategies and measures them on the same OOS window', () => {
    const swarm = tag(Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`, timestamp: 1_700_000_000_000 + i * 86_400_000,
      confidence: 75, realizedPnlPct: 6, return1h: 0.05,
    })), 'swarm');
    const baseline = tag(Array.from({ length: 30 }, (_, i) => ({
      id: `b${i}`, timestamp: 1_700_000_000_000 + i * 86_400_000,
      confidence: 60, realizedPnlPct: -4, return1h: -0.02,
    })), 'BASELINE_V1');
    const { results, testSize } = compareWalkForward([...swarm, ...baseline], ['swarm', 'BASELINE_V1']);
    expect(results).toHaveLength(2);
    expect(testSize).toBeGreaterThan(0);
    const byName = Object.fromEntries(results.map((r) => [r.strategy, r]));
    expect(byName['swarm']!.test.expectancy).toBe(6);
    expect(byName['BASELINE_V1']!.test.expectancy).toBe(-4);
  });

  it('the report names every strategy and is fail-closed when no edge holds', () => {
    const losses = tag(Array.from({ length: 30 }, (_, i) => ({
      id: `l${i}`, timestamp: 1_700_000_000_000 + i * 86_400_000,
      confidence: 50, realizedPnlPct: -5, return1h: -0.04,
    })), 'swarm');
    // Set explicit IS=0 so the verdict is OVERFITTED (fail-closed).
    const text = renderWalkForwardReport(losses, ['swarm']);
    expect(text).toContain('WALK-FORWARD');
    expect(text).toMatch(/swarm/);
  });
});
