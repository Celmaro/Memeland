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

  it('appends the PRO apikey when BLOCKSCOUT_API_KEY is set (keyless otherwise)', async () => {
    const urls: string[] = [];
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => ({ items: [] }) };
    });
    const feed = new BlockscoutFeed({ fetch: fetch as never, apiKey: 'proapi_test' });
    await feed.getBuyEvents(4663, '0xTOKEN');
    expect(urls[0]).toContain('apikey=proapi_test');
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

  // I1-4 `UNAVAILABLE != 0`. A dead enrichment feed must NOT be
  // indistinguishable from a token with genuinely no volume: that is what
  // `markBatchUnavailable` (dexscreener-feed.ts) exists to prevent. The
  // consumer half is proven in tests/wave1-rate-limit.test.ts; this proves the
  // PRODUCER sets the flag. Without it, markBatchUnavailable could be deleted
  // and every outage would silently read as a zero-volume dead token.
  it('enrichment transport failure marks the batch sourceUnavailable, never a real zero', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ tokenProfiles: [{ chainId: 'base', tokenAddress: '0xBASE', symbol: 'B' }] }) })
      .mockRejectedValueOnce(new Error('enrich down'));
    const feed = new DexScreenerFeed({ fetch: fetch as never });
    const tokens = await feed.discover({ chainIds: [8453] });
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.sourceUnavailable).toBe(true);
  });

  it('enrichment non-ok response marks the batch sourceUnavailable', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ tokenProfiles: [{ chainId: 'base', tokenAddress: '0xBASE', symbol: 'B' }] }) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    const feed = new DexScreenerFeed({ fetch: fetch as never });
    const tokens = await feed.discover({ chainIds: [8453] });
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.sourceUnavailable).toBe(true);
  });

  it('a successful enrichment leaves sourceUnavailable unset (negative control)', async () => {
    // Without this, "always marks unavailable" would satisfy the two cases
    // above while breaking the live path.
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ tokenProfiles: [{ chainId: 'base', tokenAddress: '0xBASE', symbol: 'B' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ pairs: [{ chainId: 'base', dexId: 'd', url: 'u', pairAddress: '0xP', baseToken: { address: '0xBASE', name: 'B', symbol: 'B' }, quoteToken: { address: '0xQ', name: 'Q', symbol: 'Q' }, priceUsd: '0.001', liquidity: { usd: 50000 }, volume: { h24: 120000, h1: 1500 } }] }) });
    const feed = new DexScreenerFeed({ fetch: fetch as never });
    const tokens = await feed.discover({ chainIds: [8453] });
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.sourceUnavailable).toBeUndefined();
    expect(tokens[0]!.volume24hUsd).toBe(120000);
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

// NOTE: the `decodePairCreated` regression fixture that used to live here is
// byte-identical to the stronger copy in tests/rpc-audit-wiring.test.ts, which
// imports the real PAIR_CREATED_TOPIC0 constant and additionally covers the
// malformed-input case. Two copies of one real-world log; the owner is
// rpc-audit-wiring.