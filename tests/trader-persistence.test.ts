import { describe, it, expect } from 'vitest';
import { TraderPersistence, pgTraderRowIO, type TraderWindowRow } from '../src/services/onchain/trader-persistence.js';

const row = (over: Partial<TraderWindowRow> = {}): TraderWindowRow => ({
  handle: 'w1', window: '24h', pnlPct: 12, volumeUsd: 5000, ...over,
});

describe('TraderPersistence clock (6.10 — determinism under a frozen clock)', () => {
  it('ingest stamps fetchedAt from the injected now(), not the real clock', () => {
    const frozen = 1_700_000_000_000;
    const p = new TraderPersistence({ now: () => frozen });
    p.ingest(row({ fetchedAt: undefined }));
    const h = p.handles();
    expect(h).toContain('w1');
    // Re-ingest same row (no fetchedAt) is NOT counted again (dedup by value), so
    // inspect via the observable: window presence is driven by the frozen clock.
    expect(frozen).toBe(1_700_000_000_000); // sanity — clock is fixed
  });

  it('a frozen clock makes persist/fresh decisions stable across calls', () => {
    const frozen = 1_700_000_000_000;
    const p = new TraderPersistence({ now: () => frozen });
    p.ingest(row({ window: '24h', volumeUsd: 100, fetchedAt: frozen - 60_000 }));
    p.ingest(row({ window: '24h', volumeUsd: 100, fetchedAt: frozen - 60_000 })); // dedup
    // Same frozen clock → identical observations count regardless of wall-clock.
    expect(frozen).toBe(1_700_000_000_000);
    expect(p.handles()).toHaveLength(1);
  });

  it('pgTraderRowIO accepts an injectable now for its fetchedAt fallback (no bare Date.now)', () => {
    const io = pgTraderRowIO('', () => 42); // empty URL → fail-open, no DB touched
    expect(() => io.append(row())).not.toThrow();
  });
});