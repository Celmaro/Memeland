import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlockscoutFeed } from '../src/adapters/blockscout-feed.js';
import { DexScreenerFeed, DEXSCREENER_TOKEN_PATH } from '../src/adapters/dexscreener-feed.js';
import { AnkrDiscoveryFeed, decodePairCreated } from '../src/adapters/ankr-discovery-feed.js';

// Hermetic: stub global fetch to reject fast so no test hits the network.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down (test stub)')));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BlockscoutFeed (I0-1)', () => {
  it('maps incoming token transfers to BuyEvents (from→to, amount>0)', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          { from: { hash: '0xAAA' }, to: { hash: '0xBBB' }, total: { value: '1250000' }, timestamp: '2026-09-24T00:00:00Z' },
          { from: { hash: '0xAAA' }, to: { hash: '0xCCC' }, total: { value: '500000' }, timestamp: '2026-09-24T00:00:10Z' },
          // outflow (from == contract) → skip
          { from: { hash: '0xTOKEN' }, to: { hash: '0xDDD' }, total: { value: '999' }, timestamp: '2026-09-24T00:00:20Z' },
          // zero amount → skip
          { from: { hash: '0xEEE' }, to: { hash: '0x111' }, total: { value: '0' }, timestamp: '2026-09-24T00:00:30Z' },
        ],
      }),
    });
    const feed = new BlockscoutFeed({ fetch: fetch as never });
    const events = await feed.getBuyEvents(4663, '0xTOKEN');
    expect(events.length).toBe(2);
    expect(events[0]!.wallet).toBe('0xAAA');
    expect(events[0]!.amountUsd).toBe(1250000);
    expect(events[0]!.timestamp).toBe(Date.parse('2026-09-24T00:00:00Z'));
  });

  it('fail-open → [] on transport error (voter neutralizes, never throws)', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('boom'));
    const feed = new BlockscoutFeed({ fetch: fetch as never });
    const events = await feed.getBuyEvents(4663, '0xTOKEN');
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBe(0);
  });
});

describe('DexScreenerFeed (I0-2)', () => {
  const mkFetch = (profiles: unknown[], pairs: unknown[]) =>
    vi.fn().mockImplementation(async (url: string) => {
      if (url.includes(DEXSCREENER_TOKEN_PATH)) {
        return { ok: true, json: async () => ({ pairs }) };
      }
      // profiles endpoint
      return { ok: true, json: async () => ({ tokenProfiles: profiles }) };
    });

  it('fixes the chain filter: ethereum candidates are no longer dropped', async () => {
    const fetch = mkFetch(
      [{ chainId: 'ethereum', tokenAddress: '0xETH', symbol: 'ETH1' }],
      [],
    );
    const feed = new DexScreenerFeed({ fetch: fetch as never });
    const tokens = await feed.discover({ chainIds: [1] });
    // 'ethereum' → chainId 1, which is in supportedChainIds (eth was added).
    const eth = tokens.find((t) => t.address === '0xETH');
    expect(eth).toBeDefined();
    expect(eth!.chainId).toBe(1);
  });

  it('enriches profile addresses with real market fields from /latest/dex/tokens', async () => {
    const fetch = mkFetch(
      [{ chainId: 'bsc', tokenAddress: '0xMEMA', symbol: 'MEMA' }],
      [{ chainId: 'bsc', baseToken: { address: '0xMEMA' }, priceUsd: '0.001', liquidity: { usd: 50000 }, volume: { h24: 120000 }, fdv: 200000, pairAddress: '0xPAIR', dexId: 'pancakeswap' }],
    );
    const feed = new DexScreenerFeed({ fetch: fetch as never });
    const tokens = await feed.discover({ chainIds: [56] });
    const m = tokens.find((t) => t.address === '0xMEMA');
    expect(m).toBeDefined();
    expect(m!.priceUsd).toBe(0.001);
    expect(m!.liquidityUsd).toBe(50000);
    expect(m!.volume24hUsd).toBe(120000);
    expect(m!.pairAddress).toBe('0xPAIR');
  });

  it('fail-soft: enrichment error leaves fields zero, does not throw', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ tokenProfiles: [{ chainId: 'base', tokenAddress: '0xBASE', symbol: 'B' }] }) })
      .mockRejectedValueOnce(new Error('enrich down'));
    const feed = new DexScreenerFeed({ fetch: fetch as never });
    const tokens = await feed.discover({ chainIds: [8453] });
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.volume24hUsd).toBe(0);
  });
});

describe('AnkrDiscoveryFeed (I0-3) chunked scan', () => {
  it('chunks the lookback window and reports isComplete on full coverage', async () => {
    // Stub rpc + fetch through the failover default: inject by stubbing global
    // fetch to answer eth_blockNumber + eth_getLogs with small windows.
    let getLogsCalls = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String((init as any)?.body ?? '{}'));
      if (body.method === 'eth_blockNumber') return { ok: true, json: async () => ({ result: '0x1000' }) };
      getLogsCalls += 1;
      return { ok: true, json: async () => ({ result: [] }) }; // no pairs, just exercise chunking
    }));
    const feed = new AnkrDiscoveryFeed();
    // lookback 300, chunk 100 → expect ~3 getLogs calls over chain 1 (eth).
    const res = await feed.discoverDetailed({ chainIds: [1], lookbackBlocks: 300, chunkBlocks: 100, confirmations: 12 });
    expect(res.isComplete).toBe(true);
    expect(getLogsCalls).toBeGreaterThanOrEqual(3);
    expect(res.tokens.length).toBe(0);
    expect(res.chains['eth']).toBeDefined();
    expect(res.chains['eth']!.isComplete).toBe(true);
  });
});

describe('decodePairCreated fixture (regression guard)', () => {
  it('decodes pair from data word, not the factory', () => {
    const log = {
      address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      topics: ['0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9', '0x000000000000000000000000C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0x000000000000000000000000A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
      data: '0x000000000000000000000000B4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
    } as any;
    const d = decodePairCreated(log);
    expect(d!.pair).toBe('0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc');
    expect(d!.pair).not.toBe(log.address.toLowerCase());
  });
});