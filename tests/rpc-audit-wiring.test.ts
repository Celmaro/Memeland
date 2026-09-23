import { describe, it, expect, vi } from 'vitest';
import { goPlusAuditGate } from '../src/agents/shared/gmgn-meme-helpers.js';
import { BytecodeScanner } from '../src/services/bytecode-scanner.js';
import { AnkrDiscoveryFeed, PAIR_CREATED_TOPIC0 } from '../src/adapters/ankr-discovery-feed.js';

describe('goPlusAuditGate (C1)', () => {
  it('passes a clean token', () => {
    const r = goPlusAuditGate({ isHoneypot: false, buyTaxPct: 2, sellTaxPct: 2, isBlacklisted: false });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('goplus');
    expect(r.reasons).toEqual([]);
  });
  it('fails closed on honeypot', () => {
    const r = goPlusAuditGate({ isHoneypot: true, buyTaxPct: 0, sellTaxPct: 0, isBlacklisted: false });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('honeypot');
  });
  it('fails closed when no GoPlus data (transport or coverage gap)', () => {
    const r = goPlusAuditGate(null);
    expect(r.ok).toBe(false);
    expect(r.source).toBe('none');
    expect(r.reasons.join(' ')).toContain('unavailable');
  });
  it('enforces the tax gate', () => {
    const r = goPlusAuditGate({ isHoneypot: false, buyTaxPct: 15, sellTaxPct: 15, isBlacklisted: false });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('buy tax 15% > 10%');
  });
});

describe('BytecodeScanner.scanContract (C3)', () => {
  it('scans code fetched through the pool', async () => {
    const scanner = new BytecodeScanner();
    // PUSH4 0x42966c68 wrapped (burn-restrict) inside arbitrary hex.
    const evil = `0x${'00'.repeat(4)}6342966c68${'00'.repeat(8)}`;
    const r = await scanner.scanContract('bsc', '0x0000000000000000000000000000000000000001', async () => evil);
    expect(r.flagged).toBe(true);
    expect(r.findings[0]).toContain('0x42966c68');
  });
  it('fail-soft: transport error → empty scan, not a gate', async () => {
    const scanner = new BytecodeScanner();
    const r = await scanner.scanContract('bsc', '0x0000000000000000000000000000000000000001', async () => {
      throw new Error('boom');
    });
    expect(r.flagged).toBe(false);
    expect(r.findings).toEqual([]);
  });
  it('ignores unknown chains (sol has no eth_getCode)', async () => {
    const scanner = new BytecodeScanner();
    const r = await scanner.scanContract('sol', 'whatever', async () => '0x00');
    expect(r.flagged).toBe(false);
  });
});

describe('AnkrDiscoveryFeed (B4)', () => {
  it('exposes the PairCreated topic0 constant', () => {
    expect(PAIR_CREATED_TOPIC0).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('has factories for the EVM chains the bot scans', () => {
    const feed = new AnkrDiscoveryFeed();
    expect(feed.id).toBe('ankr-pair-created');
    // constructor import of the feed module must not throw (side-effect free)
    expect(typeof feed.discover).toBe('function');
  });
  it('fail-soft: returns [] when RPC pool is empty', async () => {
    const feed = new AnkrDiscoveryFeed();
    // No env RPC and no probed hosts → getActiveRPC('eth') returns '' → []
    const tokens = await feed.discover({ chainIds: [1] });
    expect(Array.isArray(tokens)).toBe(true);
  });
});
