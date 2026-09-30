import { describe, it, expect } from 'vitest';
import {
  compareWalkForward,
  walkForwardSplit,
  type OutcomeRow,
} from '../src/orchestrator/walk-forward.js';

function row(id: string, timestamp: number, strategy: string, pnl: number): OutcomeRow {
  return { id, timestamp, confidence: 50, realizedPnlPct: pnl, strategy };
}

describe('walk-forward harness', () => {
  it('walkForwardSplit is strictly chronological and never shuffles', () => {
    const rows = [
      row('a', 100, 'A', 1),
      row('b', 300, 'A', 2),
      row('c', 500, 'A', 3),
      row('d', 700, 'B', -1),
      row('e', 900, 'B', -2),
      row('f', 1100, 'B', 4),
    ];
    const { train, validation, test } = walkForwardSplit(rows, 0.6, 0.2);
    // n=6 → train=floor(6*0.6)=3, val=floor(6*0.2)=1, test=2
    expect(train.map((r) => r.timestamp)).toEqual([100, 300, 500]);
    expect(validation.map((r) => r.timestamp)).toEqual([700]);
    expect(test.map((r) => r.timestamp)).toEqual([900, 1100]);
  });

  it('compareWalkForward evaluates every strategy on the SAME time boundaries', () => {
    // 10 rows total. Strategy A holds the earliest 4 (timestamps 0..3), strategy
    // B holds the latest 6 (timestamps 4..9).
    const rows: OutcomeRow[] = [];
    for (let ts = 0; ts < 4; ts++) rows.push(row(`a${ts}`, ts, 'A', 1));
    for (let ts = 4; ts < 10; ts++) rows.push(row(`b${ts}`, ts, 'B', 2));

    // Shared union split (n=10, 0.6/0.2): train = [0..6), val = [6..8), test = [8..10).
    // A's rows all fall in the train window → A.test.n === 0.
    // B's rows span 4..9 → B.train = 2, B.val = 2, B.test = 2.
    const { results, testSize } = compareWalkForward(rows, ['A', 'B']);

    expect(testSize).toBe(2);
    const a = results.find((r) => r.strategy === 'A')!;
    const b = results.find((r) => r.strategy === 'B')!;

    // A produced no row in the shared OOS window.
    expect(a.test.n).toBe(0);
    expect(a.train.n).toBe(4);
    // B occupies the shared train(2) / val(2) / test(2) windows exactly.
    expect(b.train.n).toBe(2);
    expect(b.validation.n).toBe(2);
    expect(b.test.n).toBe(2);
  });

  it('drops strategies that produced no rows at all', () => {
    const rows = [row('x', 0, 'A', 1), row('y', 1, 'A', 2)];
    const { results } = compareWalkForward(rows, ['A', 'missing']);
    expect(results.map((r) => r.strategy)).toEqual(['A']);
  });
});
