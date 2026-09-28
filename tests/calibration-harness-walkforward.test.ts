import { describe, it, expect } from 'vitest';
import { buildOutcomeRowsFromJournal, walkForwardReportFromJournal } from '../src/orchestrator/calibration-harness.js';
import type { TradeJournalEntry } from '../src/services/trade-journal-service.js';

function journalEntry(partial: Partial<TradeJournalEntry> & Pick<TradeJournalEntry, 'id'>): TradeJournalEntry {
  return {
    domain: 'MEME_ROBINHOOD',
    symbol: 'TEST',
    contractAddressOrId: '0xabc',
    chain: 'bsc',
    entryTimestamp: '2026-09-01T00:00:00Z',
    entryPriceUsdOrEth: 1,
    positionSizeUsd: 100,
    swarmScore: 75,
    strategyUsed: 'swarm',
    aiThesisSummary: '',
    status: 'CLOSED_TP',
    ...partial,
  };
}

describe('buildOutcomeRowsFromJournal (P6.1 realized-outcome dataset)', () => {
  it('maps only realized trades (excludes OPEN, requires signed PnL)', () => {
    const entries = [
      journalEntry({ id: 'a', realizedPnlPct: 12, status: 'CLOSED_TP' }),
      journalEntry({ id: 'b', realizedPnlPct: -8, status: 'CLOSED_SL' }),
      journalEntry({ id: 'c', status: 'OPEN' }), // no terminal PnL
      journalEntry({ id: 'd', status: 'CLOSED_MANUAL' }), // no PnL recorded
    ];
    const rows = buildOutcomeRowsFromJournal(entries);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[0]!.strategy).toBe('swarm');
  });

  it('sorts chronologically by terminal time and tags strategy', () => {
    const entries = [
      journalEntry({ id: 'late', realizedPnlPct: 5, exitTimestamp: '2026-09-05T00:00:00Z', strategyUsed: 'swarm' }),
      journalEntry({ id: 'early', realizedPnlPct: -3, exitTimestamp: '2026-09-02T00:00:00Z', strategyUsed: 'BASELINE_V1' }),
    ];
    const rows = buildOutcomeRowsFromJournal(entries);
    expect(rows.map((r) => r.id)).toEqual(['early', 'late']);
    expect(rows[1]!.strategy).toBe('swarm');
  });
});

describe('walkForwardReportFromJournal (P6.1 OOS artifact)', () => {
  it('renders a fail-closed report naming the strategies', () => {
    const entries = [
      journalEntry({ id: 'w1', realizedPnlPct: 10, status: 'CLOSED_TP', strategyUsed: 'swarm' }),
      journalEntry({ id: 'w2', realizedPnlPct: -12, status: 'CLOSED_SL', strategyUsed: 'swarm' }),
    ];
    const text = walkForwardReportFromJournal(entries, ['swarm']);
    expect(text).toContain('WALK-FORWARD');
    expect(text).toMatch(/swarm/);
  });
});
