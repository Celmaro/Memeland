/**
 * P0.2 / P0.4 — real regime population + end-to-end funnel instrumentation.
 *
 * These cover the two Phase-0 bugs that made "no steady trades" undiagnosable:
 *   P0.2 (B#1) — paper trades recorded regime=UNKNOWN because buildPayload never
 *                set payload.regime, so the 3-regime unlock gate could never
 *                reach coverage and AUTO stayed locked forever.
 *   P0.4       — the pipeline had no single-line funnel, so diagnosing which
 *                stage collapsed required a checklist across five subsystems.
 */
import { describe, it, expect } from 'vitest';
import { memeRegimeFor } from '../src/agents/shared/gmgn-meme-helpers.js';
import { PaperTradingLedger } from '../src/services/paper-trading.js';

describe('memeRegimeFor (P0.2 — detection type -> PositionRegime)', () => {
  it('maps every detected signal type onto a real regime', () => {
    expect(memeRegimeFor('CTO', false)).toBe('CTO');
    expect(memeRegimeFor('REVIVAL', false)).toBe('REVIVAL');
    // MOMENTUM is the detection vocabulary; FAST_MOMENTUM is the execution one.
    expect(memeRegimeFor('MOMENTUM', false)).toBe('FAST_MOMENTUM');
  });

  it('returns undefined for NONE instead of inventing an UNKNOWN bucket', () => {
    // An undetected token must not manufacture regime coverage — that would
    // let the unlock gate "pass" on a bucket nobody actually traded.
    expect(memeRegimeFor('NONE', false)).toBeUndefined();
  });

  it('lets a smart-money cluster outrank the raw signal type', () => {
    // Wallet convergence is the strongest live evidence, so it wins over CTO.
    expect(memeRegimeFor('CTO', true)).toBe('SMART_MONEY');
    expect(memeRegimeFor('MOMENTUM', true)).toBe('SMART_MONEY');
    expect(memeRegimeFor('REVIVAL', true)).toBe('SMART_MONEY');
    // Even a NONE detection with a cluster records the cluster regime.
    expect(memeRegimeFor('NONE', true)).toBe('SMART_MONEY');
  });

  it('produces enough distinct regimes to satisfy the 3-regime gate', () => {
    // The gate needs >= 3 regimes. The mapping must be able to supply them
    // without a code change — this is the regression that kept AUTO locked.
    const regimes = new Set(
      [memeRegimeFor('CTO', false), memeRegimeFor('REVIVAL', false), memeRegimeFor('MOMENTUM', false), memeRegimeFor('MOMENTUM', true)]
        .filter((r): r is NonNullable<typeof r> => r !== undefined),
    );
    expect(regimes.size).toBeGreaterThanOrEqual(3);
  });
});

describe('paper ledger regime coverage (P0.2 — B#1 end-to-end)', () => {
  it('counts real regimes in closedByRegime so coverage is gate-saturable', () => {
    const ledger = new PaperTradingLedger(null, () => 1_700_000_000_000);
    const seed = (symbol: string, regime: 'CTO' | 'REVIVAL' | 'SMART_MONEY') => {
      const op = ledger.openTrade({
        symbol, chain: 'sol', contractAddress: `0x${symbol}`,
        book: { bestBidUsd: 1.0, bestAskUsd: 1.0 }, liquidityUsd: 50_000, sizeUsd: 10, confidence: 90, regime,
      });
      expect(op.ok).toBe(true);
      ledger.closeTrade(op.trade!.id, 1.2, 'TP');
    };
    seed('A', 'CTO');
    seed('B', 'REVIVAL');
    seed('C', 'SMART_MONEY');

    const coverage = ledger.closedByRegime();
    // Before P0.2 every one of these landed in UNKNOWN, so the gate could
    // never see 3 regimes and AUTO was unreachable.
    expect(coverage).toEqual({ CTO: 1, REVIVAL: 1, SMART_MONEY: 1 });
    expect(coverage.UNKNOWN).toBeUndefined();
  });

  it('keeps the gate locked when only one regime has enough closed trades', () => {
    // The mapping fix must not accidentally satisfy the gate on thin coverage.
    const ledger = new PaperTradingLedger(null, () => 1_700_000_000_000);
    for (let i = 0; i < 5; i++) {
      const op = ledger.openTrade({
        symbol: `C${i}`, chain: 'sol', contractAddress: `0xC${i}`,
        book: { bestBidUsd: 1.0, bestAskUsd: 1.0 }, liquidityUsd: 50_000, sizeUsd: 10, confidence: 90, regime: 'CTO',
      });
      ledger.closeTrade(op.trade!.id, 1.5, 'TP'); // positive expectancy
    }
    const status = ledger.unlockStatus({ minRegimes: 3, minPerRegime: 5, minExpectancyPct: 0 });
    expect(status.unlocked).toBe(false);
    expect(status.reason).toContain('regimes 1/3');
  });

  it('unlocks once three regimes each clear the per-regime floor at positive expectancy', () => {
    // Positive control: the gate is reachable purely by feeding real regimes.
    const ledger = new PaperTradingLedger(null, () => 1_700_000_000_000);
    for (const regime of ['CTO', 'REVIVAL', 'SMART_MONEY'] as const) {
      for (let i = 0; i < 5; i++) {
        const op = ledger.openTrade({
          symbol: `${regime}${i}`, chain: 'sol', contractAddress: `0x${regime}${i}`,
          book: { bestBidUsd: 1.0, bestAskUsd: 1.0 }, liquidityUsd: 50_000, sizeUsd: 10, confidence: 90, regime,
        });
        ledger.closeTrade(op.trade!.id, 1.5, 'TP');
      }
    }
    const status = ledger.unlockStatus({ minRegimes: 3, minPerRegime: 5, minExpectancyPct: 0 });
    expect(status.unlocked).toBe(true);
  });
});
