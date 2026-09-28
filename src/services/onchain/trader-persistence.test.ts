import { describe, it, expect } from 'vitest';
import { TraderPersistence } from './trader-persistence.js';

function row(handle: string, window: '24h' | '7d' | '30d', pnl: number, vol: number): Parameters<TraderPersistence['ingest']>[0] {
  return { handle, window, pnlPct: pnl, volumeUsd: vol, chain: 'robinhood', solWallet: `sol_${handle}` };
}

describe('TraderPersistence', () => {
  it('returns only traders present in ALL of 24h/7d/30d (strict intersection)', () => {
    const p = new TraderPersistence();
    // persistent: appears on all three windows
    p.ingest(row('alice', '24h', 10, 500));
    p.ingest(row('alice', '7d', 20, 1500));
    p.ingest(row('alice', '30d', 30, 5000));
    // not persistent: only two windows
    p.ingest(row('bob', '24h', 5, 100));
    p.ingest(row('bob', '7d', 8, 300));
    const persistent = p.persistentTraders();
    expect(persistent.map((t) => t.handle)).toEqual(['alice']);
    const a = persistent[0]!;
    expect(a.strictPersistent).toBe(true);
    expect(a.windowsPresent).toEqual(['24h', '7d', '30d']);
    expect(a.avgPnlPct).toBeCloseTo(20);
    expect(a.totalVolumeUsd).toBe(7000);
    expect(a.lineage.inference).toBe('persistent_trader_24_7_30');
  });

  it('keeps the richer row per window and ranks by total volume', () => {
    const p = new TraderPersistence();
    p.ingest(row('carol', '24h', 1, 100));
    p.ingest(row('carol', '24h', 1, 999)); // richer 24h replaces
    p.ingest(row('carol', '7d', 2, 1000));
    p.ingest(row('carol', '30d', 3, 2000));
    const [c] = p.persistentTraders();
    expect(c.totalVolumeUsd).toBe(3999); // 999 + 1000 + 2000
  });

  it('stats() reports handles/observations/persistent counts', () => {
    const p = new TraderPersistence();
    p.ingest(row('x', '24h', 1, 1));
    const s = p.stats();
    expect(s.handles).toBe(1);
    expect(s.observations).toBe(1);
    expect(s.persistent).toBe(0);
  });
});

describe('TraderPersistence — P0 time-current (fetchedAt + freshness budget)', () => {
  const now = 1_000_000_000_000;

  it('drops a trader whose 24h observation is stale (not current board)', () => {
    const p = new TraderPersistence({ now: () => now });
    p.ingest({ handle: 'dave', window: '24h', pnlPct: 1, volumeUsd: 100, fetchedAt: now - 10 * 3600_000 }); // 10h old > 6h fresh
    p.ingest({ handle: 'dave', window: '7d', pnlPct: 1, volumeUsd: 100, fetchedAt: now - 3600_000 });
    p.ingest({ handle: 'dave', window: '30d', pnlPct: 1, volumeUsd: 100, fetchedAt: now - 3600_000 });
    expect(p.persistentTraders()).toHaveLength(0); // 24h stale → not strict
    const [d] = p.persistentTraders(false);
    expect(d.windowsPresent).not.toContain('24h');
    expect(d.strictPersistent).toBe(false);
  });

  it('keeps a trader whose all-window observations are current', () => {
    const p = new TraderPersistence({ now: () => now });
    p.ingest({ handle: 'eve', window: '24h', pnlPct: 1, volumeUsd: 100, fetchedAt: now - 60_000 });
    p.ingest({ handle: 'eve', window: '7d', pnlPct: 1, volumeUsd: 100, fetchedAt: now - 60_000 });
    p.ingest({ handle: 'eve', window: '30d', pnlPct: 1, volumeUsd: 100, fetchedAt: now - 60_000 });
    const [e] = p.persistentTraders();
    expect(e.handle).toBe('eve');
    expect(e.strictPersistent).toBe(true);
    expect(e.lastSeenAt).toBe(now - 60_000);
  });

  it('lets a fresh lower-volume row refresh presence (not locked to all-time-best)', () => {
    const p = new TraderPersistence({ now: () => now });
    p.ingest({ handle: 'frank', window: '24h', pnlPct: 1, volumeUsd: 1000, fetchedAt: now - 20 * 3600_000 }); // rich but stale
    p.ingest({ handle: 'frank', window: '24h', pnlPct: 1, volumeUsd: 50, fetchedAt: now - 60_000 }); // fresh, lower volume
    p.ingest({ handle: 'frank', window: '7d', pnlPct: 1, volumeUsd: 100, fetchedAt: now - 60_000 });
    p.ingest({ handle: 'frank', window: '30d', pnlPct: 1, volumeUsd: 100, fetchedAt: now - 60_000 });
    const [f] = p.persistentTraders();
    expect(f.totalVolumeUsd).toBe(250); // 50 + 100 + 100 — fresh row wins on time
  });
});