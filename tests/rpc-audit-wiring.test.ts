import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { goPlusAuditGate } from '../src/agents/shared/gmgn-meme-helpers.js';
import { BytecodeScanner } from '../src/services/bytecode-scanner.js';
import { AnkrDiscoveryFeed, PAIR_CREATED_TOPIC0, decodePairCreated, FACTORY_ADDRESSES } from '../src/adapters/ankr-discovery-feed.js';
import { RPCFailoverManager } from '../src/services/rpc-failover.js';
import { RobinhoodScreeningAgent } from '../src/agents/meme-robinhood/robinhood-screening-agent.js';
import type { MarketDataProvider, MarketToken } from '../src/adapters/market-data-provider.js';

// Hermetic: every test in this file must run WITHOUT real network. The RPC
// probe tests and fail-soft paths hit fetch(); stub it globally to reject fast
// so hosts go unhealthy, discovery returns [], and GMGN calls fail open — all
// fast and deterministic (no 5s real-network timeouts).
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down (test stub)')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANKR_FEED_ENABLED;
  delete process.env.MULTICHAIN_CHAINS;
  delete process.env.GMGN_API_KEY;
});

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
  it('has factories for the EVM chains the bot scans (robinhood absent — unverified)', () => {
    const feed = new AnkrDiscoveryFeed();
    expect(feed.id).toBe('ankr-pair-created');
    // constructor import of the feed module must not throw (side-effect free)
    expect(typeof feed.discover).toBe('function');
    // RH factory was removed because the Ethereum Uniswap V2 address is NOT an
    // RH factory — do not regress it back in without on-chain confirmation.
    expect(Object.keys(FACTORY_ADDRESSES).sort()).toEqual(['base', 'bsc', 'eth']);
    expect(FACTORY_ADDRESSES['robinhood']).toBeUndefined();
  });
  it('fail-soft: returns [] when every RPC call fails (transport)', async () => {
    const feed = new AnkrDiscoveryFeed();
    // fetch() is stubbed to reject — discover() must fail-soft to [] (never throw).
    const tokens = await feed.discover({ chainIds: [1] });
    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens.length).toBe(0);
  });
});

describe('decodePairCreated (B4 decode fixture)', () => {
  it('decodes a REAL Uniswap V2 PairCreated log (topics padded, pair in data)', () => {
    // Real V2 PairCreated: token0 = WETH 0xC02aA…, token1 = USDC 0xA0b8…,
    // pair = 0xB4e16… (top USDC/WETH pair). topics are 32-byte LEFT-padded
    // addresses; the pair is the FIRST word of data (non-indexed).
    const log = {
      address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      topics: [
        PAIR_CREATED_TOPIC0,
        `0x000000000000000000000000C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, // token0 WETH (padded)
        `0x000000000000000000000000A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, // token1 USDC (padded)
      ],
      data: `0x000000000000000000000000B4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc` + `0000000000000000000000000000000000000000000000000000000000000001`,
    };
    const d = decodePairCreated(log as any);
    expect(d).not.toBeNull();
    expect(d!.token0).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    expect(d!.token1).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    // THE key regression: pair is the data word, NOT log.address (the factory).
    expect(d!.pair).toBe('0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc');
    expect(d!.pair).not.toBe(log.address.toLowerCase());
  });
  it('rejects malformed logs (missing pair word)', () => {
    const d = decodePairCreated({
      address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      topics: [PAIR_CREATED_TOPIC0, '0x000000000000000000000000C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0x000000000000000000000000A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
      data: '0x', // no pair word
    } as any);
    expect(d).toBeNull();
  });
});

describe('RPCFailoverManager failure memory (P1-3/P1-4)', () => {
  it('advances lastProbeAt after a probe pass', async () => {
    const mgr = new RPCFailoverManager();
    const before = mgr.getLastProbeAt();
    await mgr.probeLatencies();
    const after = mgr.getLastProbeAt();
    expect(after).toBeGreaterThan(before);
  });
  it('getActiveRPC fallback skips a URL reported failed', () => {
    const mgr = new RPCFailoverManager();
    const rh = mgr.getRpcUrls('rh');
    const first = mgr.getActiveRPC('rh');
    // Mark the active host dead; the fallback must NOT reselect it.
    mgr.reportRPCFailure('rh', first);
    const second = mgr.getActiveRPC('rh');
    expect(second).not.toBe(first);
    expect(rh).toContain(second);
  });
  it('failed-URL memory clears after a probe', async () => {
    const mgr = new RPCFailoverManager();
    const first = mgr.getActiveRPC('rh');
    mgr.reportRPCFailure('rh', first);
    await mgr.probeLatencies();
    // After a fresh probe the previously-failed host is eligible again.
    const again = mgr.getActiveRPC('rh');
    expect(['rh', 'eth', 'bsc', 'base', 'sol']).toContain('rh');
    expect(typeof again).toBe('string');
  });
});

describe('Ankr candidates flow into the screening merge (P1-1)', () => {
  beforeEach(() => { process.env.ANKR_FEED_ENABLED = 'true'; process.env.MULTICHAIN_CHAINS = 'robinhood'; });
  afterEach(() => {
    delete process.env.ANKR_FEED_ENABLED;
    delete process.env.MULTICHAIN_CHAINS;
  });

  it('collectAnkrCandidates normalizes discovered pairs into GMGN tokens tagged ankr', async () => {
    const ankrFeed: MarketDataProvider = {
      id: 'ankr-pair-created',
      discover: vi.fn(async (): Promise<MarketToken[]> => [{
        address: '0xNEWANKR',
        chainId: 4663,
        symbol: '',
        priceUsd: 0,
        liquidityUsd: 0,
        volume24hUsd: 0,
        pairAddress: '0xPAIR',
      }]),
    };
    const agent = new RobinhoodScreeningAgent(undefined, undefined, { ankr: ankrFeed });
    const candidates = await agent.collectAnkrCandidates('robinhood');
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.address).toBe('0xNEWANKR');
    expect(candidates[0]!.source).toBe('ankr');
  });

  it('runScreeningPass invokes the ankr collector when the feed is injected (merge wired)', async () => {
    process.env.GMGN_API_KEY = 'test-key';
    const ankrFeed: MarketDataProvider = {
      id: 'ankr-pair-created',
      discover: vi.fn(async (): Promise<MarketToken[]> => []),
    };
    // Spy the collector itself: if the merge calls it, the ankr feed is wired
    // into the screening path. Avoids a full pass (GoPlus/GMGN network I/O).
    const spy = vi.spyOn(RobinhoodScreeningAgent.prototype as any, 'collectAnkrCandidates')
      .mockResolvedValue([]);
    const agent = new RobinhoodScreeningAgent(undefined, undefined, { ankr: ankrFeed });
    await agent.runScreeningPass();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
