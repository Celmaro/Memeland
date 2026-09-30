import { describe, it, expect } from 'vitest';
import { PaperTradingLedger, twoSidedMid, bookFromMid, type TwoSidedBook } from '../src/services/paper-trading.js';

describe('twoSidedMid (P6.2 mid-market — fail-closed on one-sided book)', () => {
  it('returns the mid when both sides are present', () => {
    expect(twoSidedMid({ bestBidUsd: 1.0, bestAskUsd: 1.2 })).toBeCloseTo(1.1);
  });

  it('refuses null book or any missing/non-positive side', () => {
    expect(twoSidedMid(null)).toBeNull();
    expect(twoSidedMid(undefined)).toBeNull();
    expect(twoSidedMid({ bestBidUsd: 1.0 } as TwoSidedBook)).toBeNull();
    expect(twoSidedMid({ bestBidUsd: 0, bestAskUsd: 1.2 })).toBeNull();
    expect(twoSidedMid({ bestBidUsd: 1.0, bestAskUsd: -1 })).toBeNull();
  });
});

describe('bookFromMid (P6.2 modeled two-sided book from real depth)', () => {
  it('models bid/ask around the real mid using the splash impact', () => {
    // notional 100 / liq 10_000 → impact 1% → bid 0.99, ask 1.01
    const book = bookFromMid(1.0, 10_000, 100)!;
    expect(book).not.toBeNull();
    expect(book.bestBidUsd).toBeCloseTo(0.99);
    expect(book.bestAskUsd).toBeCloseTo(1.01);
    expect(twoSidedMid(book)).toBeCloseTo(1.0);
  });

  it('refuses unknown depth or notional ≥ depth (no meaningful book)', () => {
    expect(bookFromMid(1.0, undefined, 100)).toBeNull();
    expect(bookFromMid(1.0, 0, 100)).toBeNull();
    expect(bookFromMid(1.0, 50, 100)).toBeNull(); // impact ≥ 100%
    expect(bookFromMid(0, 10_000, 100)).toBeNull();
  });
});

describe('PaperTradingLedger (P6.2 paper fills + outcome recording)', () => {
  it('opens a paper trade at two-sided mid with splash slip, refusing one-sided books', () => {
    const ledger = new PaperTradingLedger(null, () => 1_700_000_000_000);
    // One-sided → fail-closed, no trade
    const refused = ledger.openTrade({
      symbol: 'A', chain: 'sol', contractAddress: '0xA',
      book: { bestBidUsd: 1.0, bestAskUsd: 1.0 }, liquidityUsd: 0, sizeUsd: 10, confidence: 80,
    });
    expect(refused.ok).toBe(false);
    expect(ledger.all).toHaveLength(0);

    const ok = ledger.openTrade({
      symbol: 'A', chain: 'sol', contractAddress: '0xA',
      book: { bestBidUsd: 1.0, bestAskUsd: 1.2 }, liquidityUsd: 10_000, sizeUsd: 100, confidence: 80, regime: 'FAST_MOMENTUM',
    });
    expect(ok.ok).toBe(true);
    const t = ok.trade!;
    expect(t.status).toBe('OPEN');
    expect(t.entryFillPriceUsd).toBeGreaterThan(1.1); // slipped up from mid 1.1
    expect(t.slipPct).toBeGreaterThan(0);
    expect(t.regime).toBe('FAST_MOMENTUM');
  });

  it('records OPEN journal entries and closes with realized PnL (TP/SL)', () => {
    const entries: Record<string, any> = {};
    const ledger = new PaperTradingLedger(
      {
        recordTradeEntry: (e: any) => { entries[e.id] = e; return e; },
        closeTrade: (id: string, exitPriceUsd: number, status: any, exitReason?: string) => {
          if (entries[id]) { entries[id].exitPriceUsdOrEth = exitPriceUsd; entries[id].status = status; entries[id].exitReason = exitReason; }
          return entries[id];
        },
      } as any,
      () => 1_700_000_000_000,
    );
    const op = ledger.openTrade({
      symbol: 'B', chain: 'bsc', contractAddress: '0xB',
      book: { bestBidUsd: 1.0, bestAskUsd: 1.0 }, liquidityUsd: 50_000, sizeUsd: 50, confidence: 85, regime: 'REVIVAL',
    });
    expect(op.ok).toBe(true);
    const id = op.trade!.id;
    expect(entries[id]).toBeDefined();
    expect(entries[id].paper).toBe(true);
    expect(entries[id].regime).toBe('REVIVAL');
    expect(entries[id].status).toBe('OPEN');

    const closed = ledger.closeTrade(id, 1.5, 'CLOSED_TP');
    expect(closed.ok).toBe(true);
    expect(closed.pnlPct!).toBeGreaterThan(40); // 1.5 vs ~1.0x entry
    expect(entries[id].status).toBe('CLOSED_TP');
    expect(ledger.closedByRegime()).toEqual({ REVIVAL: 1 });
  });

  it('closes by scorecard linkage and rejects double-close', () => {
    const ledger = new PaperTradingLedger(null, () => 1_700_000_000_000);
    const op = ledger.openTrade({
      symbol: 'C', chain: 'base', contractAddress: '0xC',
      book: { bestBidUsd: 2, bestAskUsd: 2 }, liquidityUsd: 20_000, sizeUsd: 40, confidence: 70,
      scorecardId: 'SC_1',
    });
    expect(op.ok).toBe(true);
    expect(ledger.closeByScorecard('SC_1', 3.0, 'CLOSED_TP').ok).toBe(true);
    expect(ledger.closeTrade(op.trade!.id, 3.0, 'CLOSED_TP').ok).toBe(false); // already closed
    expect(ledger.closeByScorecard('NOPE', 3.0, 'CLOSED_TP').ok).toBe(false);
  });
});

describe('paperUnlockGate (P6.2 regime-coverage approval gate — fail-closed)', () => {
  function fillRegimes(ledger: PaperTradingLedger, counts: Record<string, number>, winPnlPct = 5) {
    for (const [regime, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) {
        const op = ledger.openTrade({
          symbol: `${regime}${i}`, chain: 'eth', contractAddress: `0x${regime}${i}`,
          book: { bestBidUsd: 1, bestAskUsd: 1 }, liquidityUsd: 100_000, sizeUsd: 10, confidence: 80, regime: regime as any,
        });
        if (op.ok) ledger.closeTrade(op.trade!.id, 1 + winPnlPct / 100, 'CLOSED_TP');
      }
    }
  }

  it('locked until ≥3 regimes each with ≥5 closed trades (fail-closed)', () => {
    const ledger = new PaperTradingLedger(null, () => 1_700_000_000_000);
    fillRegimes(ledger, { FAST_MOMENTUM: 5, REVIVAL: 5 }); // only 2 regimes
    const s1 = ledger.unlockStatus();
    expect(s1.unlocked).toBe(false);
    expect(s1.reason).toContain('PAPER GATE locked');

    fillRegimes(ledger, { CTO: 5 }); // now 3 regimes × 5, positive expectancy
    const s2 = ledger.unlockStatus();
    expect(s2.unlocked).toBe(true);
    expect(s2.coverage).toEqual({ FAST_MOMENTUM: 5, REVIVAL: 5, CTO: 5 });
  });

  it('stays locked when expectancy is not positive', () => {
    const ledger = new PaperTradingLedger(null, () => 1_700_000_000_000);
    fillRegimes(ledger, { FAST_MOMENTUM: 5, REVIVAL: 5, CTO: 5 }, -5); // losing paper trades
    const s = ledger.unlockStatus();
    expect(s.unlocked).toBe(false);
    expect(s.expectancyPct).toBeLessThan(0);
  });

  it('respects custom thresholds (fail-closed with higher bar)', () => {
    const ledger = new PaperTradingLedger(null, () => 1_700_000_000_000);
    fillRegimes(ledger, { FAST_MOMENTUM: 3, REVIVAL: 3, CTO: 3 }); // 3×3
    expect(ledger.unlockStatus({ minRegimes: 3, minPerRegime: 2 }).unlocked).toBe(true); // low bar
    expect(ledger.unlockStatus({ minRegimes: 3, minPerRegime: 5 }).unlocked).toBe(false); // default bar 5
  });
});

describe('PaperTradingLedger durability (P8 — state survives restart via hydrate)', () => {
  const book: TwoSidedBook = { bestBidUsd: 1.0, bestAskUsd: 1.2 };
  const openOne = (l: PaperTradingLedger) =>
    l.openTrade({
      symbol: 'MEME', chain: 'robinhood', contractAddress: '0xM', book,
      liquidityUsd: 10000, sizeUsd: 100, confidence: 0.6, regime: 'REVIVAL' as any,
    });

  it('hydrate rebuilds closed-trade coverage so the unlock gate survives a restart', () => {
    const before = new PaperTradingLedger(null, () => 1_700_000_000_000);
    // 3 regimes × 1 OPEN paper trade each, then all closed.
    for (const regime of ['FAST_MOMENTUM', 'REVIVAL', 'CTO']) {
      const r = before.openTrade({
        symbol: 'MEME', chain: 'robinhood', contractAddress: '0x1', book,
        liquidityUsd: 10000, sizeUsd: 100, confidence: 0.6, regime: regime as any,
      });
      before.closeTrade(r.trade!.id, 1.5, 'CLOSED_TP');
    }
    // "Restart": a fresh ledger hydrates from the durable snapshot and re-locks
    // in exactly the same way (same closed-coveraged evidence).
    const after = new PaperTradingLedger(null, () => 1_700_000_000_000);
    after.hydrate(before.all);
    expect(after.all).toHaveLength(3);
    expect(after.closedByRegime()).toEqual({ FAST_MOMENTUM: 1, REVIVAL: 1, CTO: 1 });
    // Only 1 per regime closes the gate coverage but not the default bar of 5 →
    // fail-closed, proving insignificant history is NOT rewarded across restarts.
    expect(after.unlockStatus().unlocked).toBe(false);
    expect(after.unlockStatus().reason).toContain('regimes 0/3');
  });

  it('hydrate refuses to clobber a ledger that already recorded this process', () => {
    const l = new PaperTradingLedger(null, () => 1_700_000_000_000);
    openOne(l); // live trade recorded this process
    const before = l.all;
    // A stale durable snapshot must NOT override the live run's state.
    l.hydrate([]);
    l.hydrate(before);
    expect(l.all).toHaveLength(1); // hydrate is a no-op once the ledger is live
  });
});