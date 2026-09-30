import { describe, it, expect } from 'vitest';
import { TraderPersistence, walletNativeCohorts } from './trader-persistence.js';
import { WalletGraph } from './wallet-graph.js';

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

describe('walletNativeCohorts (Phase 4) — handle→wallet→canonical trader collapse', () => {
  it('collapses provider handles sharing a wallet cluster into ONE cohort with combined volume', () => {
    const now = 1_000_000_000_000;
    const p = new TraderPersistence({ now: () => now });
    const g = new WalletGraph();
    // alice (fomo) and alice_gmgn (gmgn) share 0xEVMA → one physical actor.
    p.ingest({ handle: 'alice', window: '24h', pnlPct: 10, volumeUsd: 500, chain: 'solana', solWallet: 'solA', evmWallet: '0xEVMA', provider: 'fomo', fetchedAt: now - 60_000 });
    p.ingest({ handle: 'alice', window: '7d', pnlPct: 20, volumeUsd: 1500, chain: 'solana', solWallet: 'solA', evmWallet: '0xEVMA', provider: 'fomo', fetchedAt: now - 60_000 });
    p.ingest({ handle: 'alice', window: '30d', pnlPct: 30, volumeUsd: 5000, chain: 'solana', solWallet: 'solA', evmWallet: '0xEVMA', provider: 'fomo', fetchedAt: now - 60_000 });
    p.ingest({ handle: 'alice_gmgn', window: '24h', pnlPct: 5, volumeUsd: 2000, chain: 'bsc', evmWallet: '0xEVMA', provider: 'gmgn', fetchedAt: now - 60_000 });
    g.registerHandle('alice', { chain: 'solana', provider: 'fomo', wallets: ['solA', '0xEVMA'] });
    g.registerHandle('alice_gmgn', { chain: 'bsc', provider: 'gmgn', wallets: ['0xEVMA', '0xBNBA'] });

    const cohorts = walletNativeCohorts(p, g);
    const alice = cohorts.find((c) => c.handles.includes('alice'));
    expect(alice).toBeDefined();
    expect(alice!.collapsedTraders).toBe(2); // alice + alice_gmgn → one actor
    expect(alice!.totalVolumeUsd).toBe(9000); // 7000 (alice) + 2000 (alice_gmgn)
    expect(alice!.strictCount).toBe(1); // only alice is on all three windows
    expect(alice!.providers.sort()).toEqual(['fomo', 'gmgn']);
  });

  it('ranks cohorts by volume (singleton unresolved handles kept, not dropped)', () => {
    const now = 1_000_000_000_000;
    const p = new TraderPersistence({ now: () => now });
    const g = new WalletGraph();
    // bob persistent, no wallet resolution → singleton cohort (never silently dropped).
    p.ingest({ handle: 'bob', window: '24h', pnlPct: 1, volumeUsd: 100, fetchedAt: now - 60_000 });
    p.ingest({ handle: 'bob', window: '7d', pnlPct: 1, volumeUsd: 100, fetchedAt: now - 60_000 });
    p.ingest({ handle: 'bob', window: '30d', pnlPct: 1, volumeUsd: 100, fetchedAt: now - 60_000 });
    const cohorts = walletNativeCohorts(p, g);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]!.handles).toEqual(['bob']);
    expect(cohorts[0]!.totalVolumeUsd).toBe(300);
    expect(cohorts[0]!.collapsedTraders).toBe(1);
  });
});

describe('TraderPersistence P9 — durability (hydrate rebuilds the ledger)', () => {
  it('hydrate rebuilds rows/observations so the strict persistence signal survives a restart', async () => {
    const now = 1_700_000_000_000;
    const file = require('path').join(require('os').tmpdir(), `memeland-tp-${Date.now()}.jsonl`);
    try {
      const { fileTraderRowIO, loadTraderRows } = await import('./trader-persistence.js');
      const before = new TraderPersistence({ now: () => now }, fileTraderRowIO(file));
      before.ingest({ handle: 'alice', window: '24h', pnlPct: 10, volumeUsd: 100, fetchedAt: now });
      before.ingest({ handle: 'alice', window: '7d', pnlPct: 20, volumeUsd: 200, fetchedAt: now });
      before.ingest({ handle: 'alice', window: '30d', pnlPct: 30, volumeUsd: 300, fetchedAt: now });

      // "Restart": re-apply the durable rows into a fresh ledger.
      const after = new TraderPersistence({ now: () => now });
      after.hydrate(await loadTraderRows({ file }));
      expect(after.stats().handles).toBe(1);
      expect(after.stats().observations).toBe(3);
      const strict = after.persistentTraders();
      expect(strict).toHaveLength(1);
      expect(strict[0]!.handle).toBe('alice');
      expect(strict[0]!.strictPersistent).toBe(true);
    } finally {
      await require('fs').promises.rm(file, { force: true });
    }
  });

  it('hydrate refuses to clobber a ledger that already recorded this process', () => {
    const p = new TraderPersistence();
    p.ingest({ handle: 'live', window: '24h', pnlPct: 1, volumeUsd: 1 });
    p.hydrate([{ handle: 'ghost', window: '24h', pnlPct: 99, volumeUsd: 99 }]);
    expect(p.handles()).toEqual(['live']);
  });
});