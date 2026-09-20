import { describe, it, expect, vi } from 'vitest';
import type { PaperFill } from '../src/services/solana-copy-trade.js';
import {
  sizeCopyPosition,
  PaperBroker,
  reconcilePnl,
} from '../src/services/solana-copy-trade.js';

describe('sizeCopyPosition (proportional sizing)', () => {
  const cfg = { baseNotionalUsd: 100, maxNotionalUsd: 500, minNotionalUsd: 10 };

  it('sizes as base * multiplier within [min, max]', () => {
    // 100 * 2 = 200, inside [10, 500].
    expect(sizeCopyPosition(100, 2, cfg)).toBe(200);
    // 100 * 0.5 = 50, still above min.
    expect(sizeCopyPosition(100, 0.5, cfg)).toBe(50);
    // base * multiplier exactly hits the configured floor of 10.
    expect(sizeCopyPosition(10, 1, cfg)).toBe(10);
  });

  it('floors undersized results up to minNotionalUsd', () => {
    // 100 * 0.02 = 2 -> clamped to min = 10.
    expect(sizeCopyPosition(100, 0.02, cfg)).toBe(10);
    // 5 * 1 = 5 -> clamped to min = 10.
    expect(sizeCopyPosition(5, 1, cfg)).toBe(10);
  });

  it('caps oversized results down to maxNotionalUsd', () => {
    // 100 * 10 = 1000 -> capped to max = 500.
    expect(sizeCopyPosition(100, 10, cfg)).toBe(500);
    // 1000 * 1 = 1000 -> capped to max = 500.
    expect(sizeCopyPosition(1000, 1, cfg)).toBe(500);
  });

  it('returns 0 for invalid (negative or non-finite) inputs (fail-closed)', () => {
    expect(sizeCopyPosition(-100, 2, cfg)).toBe(0); // negative base
    expect(sizeCopyPosition(100, -2, cfg)).toBe(0); // negative multiplier
    expect(sizeCopyPosition(NaN, 2, cfg)).toBe(0); // NaN base
    expect(sizeCopyPosition(100, NaN, cfg)).toBe(0); // NaN multiplier
    expect(sizeCopyPosition(Infinity, 2, cfg)).toBe(0); // non-finite base
    expect(sizeCopyPosition(100, Infinity, cfg)).toBe(0); // non-finite multiplier
  });

  it('returns 0 when minNotionalUsd > maxNotionalUsd (misconfigured)', () => {
    const bad = { baseNotionalUsd: 100, maxNotionalUsd: 10, minNotionalUsd: 50 };
    expect(sizeCopyPosition(100, 2, bad)).toBe(0);
  });
});

describe('PaperBroker fill pricing (deterministic slip math)', () => {
  it('applies positive slippage to a buy fill', async () => {
    const broker = new PaperBroker();
    const r = await broker.submitFill({
      tokenAddress: 'TOK',
      side: 'buy',
      sizeUsd: 1000,
      midPriceUsd: 1,
      slippagePct: 10,
    });
    expect(r.accepted).toBe(true);
    const f = r.fill!;
    // fillPrice = 1 * (1 + 10/100 * 1) = 1.10
    expect(f.fillPriceUsd).toBeCloseTo(1.1, 6);
    // slipUsd = |1.1 - 1| * 1000 / 1 = 100
    expect(f.slipUsd).toBeCloseTo(100, 6);
  });

  it('adjusts a sell fill price downward and still records a positive slip', async () => {
    const broker = new PaperBroker();
    const r = await broker.submitFill({
      tokenAddress: 'TOK',
      side: 'sell',
      sizeUsd: 500,
      midPriceUsd: 2,
      slippagePct: 5,
    });
    expect(r.accepted).toBe(true);
    const f = r.fill!;
    // fillPrice = 2 * (1 - 5/100) = 1.90
    expect(f.fillPriceUsd).toBeCloseTo(1.9, 6);
    // slipUsd = |1.9 - 2| * 500 / 2 = 25
    expect(f.slipUsd).toBeCloseTo(25, 6);
  });

  it('zero slippage leaves fill price == mid price and slip == 0', async () => {
    const broker = new PaperBroker();
    const r = await broker.submitFill({
      tokenAddress: 'TOK',
      side: 'buy',
      sizeUsd: 200,
      midPriceUsd: 1.5,
      slippagePct: 0,
    });
    expect(r.accepted).toBe(true);
    expect(r.fill!.fillPriceUsd).toBeCloseTo(1.5, 6);
    expect(r.fill!.slipUsd).toBe(0);
  });
});

describe('PaperBroker fail-closed (zero/illiquid depth never best-effort)', () => {
  it('rejects zero or negative size', async () => {
    const broker = new PaperBroker();
    const zero = await broker.submitFill({
      tokenAddress: 'TOK', side: 'buy', sizeUsd: 0, midPriceUsd: 1, slippagePct: 1,
    });
    expect(zero.accepted).toBe(false);
    expect(zero.reason).toBe('zero/illiquid depth — fail-closed');
    const negative = await broker.submitFill({
      tokenAddress: 'TOK', side: 'buy', sizeUsd: -50, midPriceUsd: 1, slippagePct: 1,
    });
    expect(negative.accepted).toBe(false);
  });

  it('rejects zero or negative mid price', async () => {
    const broker = new PaperBroker();
    const zero = await broker.submitFill({
      tokenAddress: 'TOK', side: 'buy', sizeUsd: 100, midPriceUsd: 0, slippagePct: 1,
    });
    expect(zero.accepted).toBe(false);
    expect(zero.reason).toBe('zero/illiquid depth — fail-closed');
    const negative = await broker.submitFill({
      tokenAddress: 'TOK', side: 'buy', sizeUsd: 100, midPriceUsd: -1, slippagePct: 1,
    });
    expect(negative.accepted).toBe(false);
  });

  it('rejects a sell whose slippage drives the fill price to zero/negative', async () => {
    const broker = new PaperBroker();
    // slippage 100% on a sell => fillPrice = mid * (1 - 1) = 0.
    const r = await broker.submitFill({
      tokenAddress: 'TOK', side: 'sell', sizeUsd: 100, midPriceUsd: 1, slippagePct: 100,
    });
    expect(r.accepted).toBe(false);
    expect(r.reason).toBe('zero/illiquid depth — fail-closed');
  });

  it('does not record rejected fills and rejects are never best-effort', async () => {
    const broker = new PaperBroker();
    await broker.submitFill({
      tokenAddress: 'TOK', side: 'buy', sizeUsd: 0, midPriceUsd: 1, slippagePct: 1,
    });
    expect(broker.fills).toHaveLength(0);
    expect(broker.sequence).toBe(0);
  });
});

describe('PaperBroker with injected transport (dry-run simulate)', () => {
  it('still records the fill when transport declines, and calls transport once', async () => {
    const submit = vi.fn(async () => ({ accepted: false }));
    const broker = new PaperBroker({ submit });
    const r = await broker.submitFill({
      tokenAddress: 'TOK', side: 'buy', sizeUsd: 1000, midPriceUsd: 1, slippagePct: 5,
    });
    // Paper broker accepts + records regardless of transport decline.
    expect(r.accepted).toBe(true);
    expect(r.fill).toBeDefined();
    expect(broker.fills).toHaveLength(1);
    expect(broker.fills[0].sequence).toBe(1);
    // The injected transport was called exactly once.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ id: r.fill!.id }));
  });

  it('treats a transport rejection as reporting-only, not a gate on recording', async () => {
    const submit = vi.fn(async () => ({ accepted: false }));
    const broker = new PaperBroker({ submit });
    await broker.submitFill({
      tokenAddress: 'TOK', side: 'sell', sizeUsd: 300, midPriceUsd: 2, slippagePct: 1,
    });
    // Fill is present even though the live-ish transport said no.
    expect(broker.fills).toHaveLength(1);
    expect(broker.fills[0].side).toBe('sell');
  });
});

describe('PaperBroker closePosition + reconcilePnl (idempotent reconcile)', () => {
  it('closes a fill, realizes PnL, and a second close does not double-count', async () => {
    const broker = new PaperBroker();
    const buy = await broker.submitFill({
      tokenAddress: 'TOK', side: 'buy', sizeUsd: 1000, midPriceUsd: 1, slippagePct: 1,
    });
    const fill = buy.fill!;

    const first = broker.closePosition('TOK', fill.id);
    expect(first.ok).toBe(true);
    expect(first.realizedPnlUsd).toBe(-1000); // buy debit

    const pnlAfterFirst = reconcilePnl(broker.fills);
    // Closed buy of 1000 -> buysUsd 1000, net -1000.
    expect(pnlAfterFirst.buysUsd).toBe(1000);
    expect(pnlAfterFirst.netUsd).toBe(-1000);

    // Closing the same fill again: idempotent, no extra PnL, reconcile unchanged.
    const second = broker.closePosition('TOK', fill.id);
    expect(second.ok).toBe(true);
    expect(second.realizedPnlUsd).toBe(0);

    const pnlAfterSecond = reconcilePnl(broker.fills);
    expect(pnlAfterSecond.buysUsd).toBe(pnlAfterFirst.buysUsd);
    expect(pnlAfterSecond.sellsUsd).toBe(pnlAfterFirst.sellsUsd);
    expect(pnlAfterSecond.netUsd).toBe(pnlAfterFirst.netUsd);
  });

  it('reconciles closed fills without double-counting duplicates by id', () => {
    const closedBuy: PaperFill = {
      id: '1:TOK:buy', tokenAddress: 'TOK', side: 'buy', sizeUsd: 100,
      midPriceUsd: 1, slippagePct: 0, fillPriceUsd: 1, slipUsd: 0, sequence: 1, closed: true,
    };
    const closedSell: PaperFill = {
      id: '2:TOK:sell', tokenAddress: 'TOK', side: 'sell', sizeUsd: 40,
      midPriceUsd: 1, slippagePct: 0, fillPriceUsd: 1, slipUsd: 0, sequence: 2, closed: true,
    };
    const openBuy: PaperFill = {
      id: '3:TOK:buy', tokenAddress: 'TOK', side: 'buy', sizeUsd: 999,
      midPriceUsd: 1, slippagePct: 0, fillPriceUsd: 1, slipUsd: 0, sequence: 3,
    };
    // Pass the same closed fill twice in the list: unique-id dedupe must count it once.
    const pnl = reconcilePnl([closedBuy, closedBuy, closedSell, openBuy]);
    expect(pnl.buysUsd).toBe(100); // not 200
    expect(pnl.sellsUsd).toBe(40);
    expect(pnl.netUsd).toBe(-60);
  });

  it('returns realized PnL only once per fill across close + reconcile', async () => {
    const broker = new PaperBroker();
    const sell = await broker.submitFill({
      tokenAddress: 'TOK', side: 'sell', sizeUsd: 250, midPriceUsd: 2, slippagePct: 1,
    });
    const close = broker.closePosition('TOK', sell.fill!.id);
    expect(close.realizedPnlUsd).toBe(250); // sell credit
    const pnl = reconcilePnl(broker.fills);
    expect(pnl.sellsUsd).toBe(250);
    expect(pnl.netUsd).toBe(250);
  });
});

describe('PaperBroker closePosition rejects unknown / mismatched fills', () => {
  it('rejects when the fillId does not match any open fill', async () => {
    const broker = new PaperBroker();
    const res = broker.closePosition('TOK', 'does-not-exist');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no matching open fill');
    expect(res.realizedPnlUsd).toBe(0);
  });

  it('rejects a fillId that exists but belongs to a different token', async () => {
    const broker = new PaperBroker();
    const buy = await broker.submitFill({
      tokenAddress: 'AAA', side: 'buy', sizeUsd: 100, midPriceUsd: 1, slippagePct: 1,
    });
    const res = broker.closePosition('BBB', buy.fill!.id);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no matching open fill');
  });
});
