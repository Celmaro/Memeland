import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { StateStore } from '../src/services/state-store.js';

const dbPaths: string[] = [];
const stores: StateStore[] = [];

function newStore(): StateStore {
  const p = path.join(process.cwd(), 'database', `test_state_store_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  dbPaths.push(p);
  const s = new StateStore(p);
  stores.push(s);
  return s;
}

function storeOn(p: string): StateStore {
  const s = new StateStore(p);
  stores.push(s);
  return s;
}

describe('StateStore trackedTokens persistence', () => {
  afterAll(() => {
    // Flush first so no pending debounce timers rewrite the files after deletion
    for (const s of stores) {
      try { s.flushToDisk(); } catch { /* ignore */ }
    }
    for (const p of dbPaths) {
      for (const f of [p, `${p}.tmp`]) {
        try { fs.unlinkSync(f); } catch { /* already gone */ }
      }
    }
  });

  it('setTrackedToken + getTrackedTokens round-trips and persists across reloads', () => {
    const store = newStore();
    store.setTrackedToken({ chain: 'robinhood', address: 'AAA111', symbol: 'EVMTOK', addedAt: 1000 });
    store.flushToDisk();

    const reloaded = storeOn(dbPaths[dbPaths.length - 1]);
    const tokens = reloaded.getTrackedTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({ chain: 'robinhood', address: 'AAA111', symbol: 'EVMTOK', addedAt: 1000 });
  });

  it('dedupes by chain+address (case-insensitive) and updates the existing entry', () => {
    const store = newStore();
    store.setTrackedToken({ chain: 'robinhood', address: 'AAA111', symbol: 'EVMTOK', addedAt: 1000 });
    store.setTrackedToken({ chain: 'robinhood', address: 'aaa111', symbol: 'EVMTOK2', addedAt: 2000 });
    const tokens = store.getTrackedTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].symbol).toBe('EVMTOK2');
    expect(tokens[0].addedAt).toBe(2000);
  });

  it('loads an empty trackedTokens list for legacy state files without the field', () => {
    const p = path.join(process.cwd(), 'database', `test_state_store_legacy_${Date.now()}.json`);
    dbPaths.push(p);
    fs.writeFileSync(p, JSON.stringify({ version: 2, openPositions: {} }), 'utf-8');
    const store = storeOn(p);
    expect(store.getTrackedTokens()).toEqual([]);
  });

  it('addApprovalOrder + getApprovalOrder round-trips and persists across reloads', () => {
    const store = newStore();
    store.addApprovalOrder({
      id: 'APR_1',
      domain: 'meme-robinhood',
      symbol: 'TEST',
      contractAddress: '0xabc',
      chain: 'robinhood',
      entryPriceUsd: 0.5,
      suggestedSizeUsd: 100,
      confidence: 85,
      thesis: 'swarm',
      status: 'PENDING',
      createdAtIso: '2026-09-19T00:00:00.000Z',
    });
    store.flushToDisk();

    const reloaded = storeOn(dbPaths[dbPaths.length - 1]);
    const orders = reloaded.getApprovalOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe('APR_1');
    expect(orders[0].status).toBe('PENDING');
  });

  it('updateApprovalOrder upserts an existing order (status/decision change)', () => {
    const store = newStore();
    store.addApprovalOrder({
      id: 'APR_1',
      domain: 'meme-robinhood',
      symbol: 'TEST',
      contractAddress: '0xabc',
      chain: 'robinhood',
      entryPriceUsd: 0.5,
      suggestedSizeUsd: 100,
      confidence: 85,
      thesis: 'swarm',
      status: 'PENDING',
      createdAtIso: '2026-09-19T00:00:00.000Z',
    });
    const updated = {
      ...store.getApprovalOrder('APR_1')!,
      status: 'APPROVED' as const,
      decidedBy: 'op',
      decidedAtIso: '2026-09-19T01:00:00.000Z',
    };
    store.updateApprovalOrder(updated);
    const order = store.getApprovalOrder('APR_1');
    expect(order?.status).toBe('APPROVED');
    expect(order?.decidedBy).toBe('op');
    expect(store.getApprovalOrders()).toHaveLength(1);
  });

  it('loads an empty approvalOrders list for legacy state files without the field', () => {
    const p = path.join(process.cwd(), 'database', `test_state_store_noapproval_${Date.now()}.json`);
    dbPaths.push(p);
    fs.writeFileSync(p, JSON.stringify({ version: 2, openPositions: {}, scorecard: [] }), 'utf-8');
    const store = storeOn(p);
    expect(store.getApprovalOrders()).toEqual([]);
  });

  it('scorecard flips TP at +100% and SL at -50% (mirrors position-manager), not +50/-20', () => {
    const store = newStore();
    store.appendScorecardEntry({
      id: 'SC_1',
      symbol: 'X',
      chain: 'robinhood',
      contractAddress: '0x1',
      confidence: 90,
      entryPriceUsd: 1,
      currentPriceUsd: 1,
      entryTimestampIso: '2026-09-19T00:00:00.000Z',
      updatedAtIso: '2026-09-19T00:00:00.000Z',
      status: 'OPEN',
    });
    store.appendScorecardEntry({
      id: 'SC_2',
      symbol: 'Y',
      chain: 'robinhood',
      contractAddress: '0x2',
      confidence: 90,
      entryPriceUsd: 1,
      currentPriceUsd: 1,
      entryTimestampIso: '2026-09-19T00:00:00.000Z',
      updatedAtIso: '2026-09-19T00:00:00.000Z',
      status: 'OPEN',
    });

    // Neither +50% nor -20% should flip — thresholds are now +100%/-50%.
    store.updateScorecardPrice('SC_1', 1.5, '2026-09-19T00:01:00.000Z');
    store.updateScorecardPrice('SC_2', 0.8, '2026-09-19T00:01:00.000Z');
    const mid = store.getScorecard();
    expect(mid.find((e) => e.id === 'SC_1')?.status).toBe('OPEN');
    expect(mid.find((e) => e.id === 'SC_2')?.status).toBe('OPEN');

    // +100% -> TP, -50% -> SL.
    store.updateScorecardPrice('SC_1', 2.0, '2026-09-19T00:02:00.000Z');
    store.updateScorecardPrice('SC_2', 0.5, '2026-09-19T00:02:00.000Z');
    const flipped = store.getScorecard();
    expect(flipped.find((e) => e.id === 'SC_1')?.status).toBe('TP');
    expect(flipped.find((e) => e.id === 'SC_2')?.status).toBe('SL');
  });
});
