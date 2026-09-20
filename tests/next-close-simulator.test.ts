import { describe, it, expect } from 'vitest';
import {
  simulateNextClose,
  checkDecisionAvailability,
} from '../src/services/next-close-simulator.js';

const bars = [
  { time: 0, high: 11, low: 9, close: 10, liquidityUsd: 100000 },
  { time: 1, high: 21, low: 19, close: 20, liquidityUsd: 100000 },
  { time: 2, high: 31, low: 29, close: 30, liquidityUsd: 100000 },
  { time: 3, high: 41, low: 39, close: 40, liquidityUsd: 100000 },
];

describe('simulateNextClose fills on next observed close', () => {
  it('fills a buy at the next bar close, not the decision bar', () => {
    const res = simulateNextClose(bars, [
      { id: 'b1', side: 'buy', sizeUsd: 100, decisionBarIndex: 0 },
    ], { feePct: 0, slippagePct: 0 });
    const fill = res.fills.find((f) => f.orderId === 'b1')!;
    expect(fill.status).toBe('filled');
    expect(fill.barIndex).toBe(1);
    expect(fill.fillPrice).toBe(20);
    expect(fill.qty).toBeCloseTo(5, 6);
  });

  it('cancels a fill that gaps past the allowed bar window', () => {
    const res = simulateNextClose(bars, [
      { id: 'b1', side: 'buy', sizeUsd: 100, decisionBarIndex: 0, maxGapBars: 0 },
    ], { feePct: 0, slippagePct: 0 });
    const fill = res.fills.find((f) => f.orderId === 'b1')!;
    expect(fill.status).toBe('cancelled');
    expect(fill.cancelReason).toBe('gap');
    expect(res.cancelledCount).toBe(1);
  });

  it('keeps an order open when there is no next bar of data', () => {
    const res = simulateNextClose(bars, [
      { id: 'b1', side: 'buy', sizeUsd: 100, decisionBarIndex: 3 },
    ], { feePct: 0, slippagePct: 0 });
    const fill = res.fills.find((f) => f.orderId === 'b1')!;
    expect(fill.status).toBe('open');
    expect(res.openQty).toBeCloseTo(0, 6);
  });
});

describe('simulateNextClose conservative fees and slippage', () => {
  it('raises the buy fill price and charges a fee', () => {
    const res = simulateNextClose(bars, [
      { id: 'b1', side: 'buy', sizeUsd: 100, decisionBarIndex: 0 },
    ], { feePct: 0.3, slippagePct: 0.2 });
    const fill = res.fills.find((f) => f.orderId === 'b1')!;
    expect(fill.fillPrice).toBeGreaterThan(20); // 20 * 1.002
    expect(fill.feesUsd).toBeGreaterThan(0);
    expect(fill.slippageUsd).toBeGreaterThan(0);
    // qty = (sizeUsd - fee) / fillPrice
    expect(fill.qty).toBeCloseTo((100 - 0.3) / 20.04, 6);
  });
});

describe('simulateNextClose FIFO lots', () => {
  it('consumes the earliest buy lot first and realizes PnL on the matched lot', () => {
    const res = simulateNextClose(bars, [
      { id: 'b1', side: 'buy', sizeUsd: 100, decisionBarIndex: 0 },  // fills bar1 @20
      { id: 'b2', side: 'buy', sizeUsd: 50, decisionBarIndex: 1 },   // fills bar2 @30
      { id: 's1', side: 'sell', sizeUsd: 40, decisionBarIndex: 2 },  // fills bar3 @40, FIFO vs b1
    ], { feePct: 0, slippagePct: 0 });

    const fillB1 = res.fills.find((f) => f.orderId === 'b1')!;
    const fillB2 = res.fills.find((f) => f.orderId === 'b2')!;
    const fillS1 = res.fills.find((f) => f.orderId === 's1')!;
    expect(fillB1.fillPrice).toBe(20); // first lot: entry 20
    expect(fillB2.fillPrice).toBe(30);
    expect(fillS1.status).toBe('filled');

    const closed = res.closed[0]!;
    // FIFO matches sell against b1 lot (entry 20), exit 40
    expect(closed.entryPrice).toBe(20);
    expect(closed.exitPrice).toBe(40);
    // sell size 40 -> qty = 40 / 40 = 1
    expect(closed.qty).toBeCloseTo(1, 6);
    expect(closed.grossPnlUsd).toBeCloseTo((40 - 20) * 1, 6);
  });
});

describe('checkDecisionAvailability (A22 DAG + P0/P1)', () => {
  it('fails closed (P0) when a decision consumes a fact released after its decision time', () => {
    const ev = checkDecisionAvailability([
      { id: 'close', releasedAt: 6, decisionTime: 5 },
    ]);
    expect(ev.passed).toBe(false);
    expect(ev.severity).toBe('P0');
    expect(ev.violations.length).toBeGreaterThan(0);
  });

  it('passes a timely release and reports P1 for a value-dependent fact', () => {
    const ok = checkDecisionAvailability([
      { id: 'close', releasedAt: 5, decisionTime: 5 },
    ]);
    expect(ok.passed).toBe(true);

    const vd = checkDecisionAvailability([
      { id: 'model', releasedAt: 5, decisionTime: 6, valueDependent: true },
    ]);
    expect(vd.passed).toBe(true);
    expect(vd.severity).toBe('P1');
    expect(vd.violations.length).toBeGreaterThan(0);
  });

  it('detects a cycle in the dependency DAG', () => {
    const ev = checkDecisionAvailability([
      { id: 'a', inputs: ['b'], releasedAt: 1, decisionTime: 2 },
      { id: 'b', inputs: ['a'], releasedAt: 1, decisionTime: 2 },
    ]);
    expect(ev.passed).toBe(false);
    expect(ev.severity).toBe('P0');
  });
});
