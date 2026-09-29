import { afterEach, describe, expect, it } from 'vitest';
import { GeckoDiscoveryFeed } from '../src/adapters/gecko-discovery-feed.js';

/** Minimal GeckoTerminal v2 pool-row fixture — ALL-NETWORKS response shape:
 *  base_token id is a RAW address; the chain lives in
 *  relationships.network.data.id (the shape /networks/{kind} returns). */
function poolRow(overrides: { address: string; name: string; network: string; priceUsd?: string; reserveUsd?: string; volumeUsd?: string; fdvUsd?: string }) {
  return {
    id: `0xPool_${overrides.address}`,
    type: 'pool',
    attributes: {
      address: `0xPair_${overrides.address}`,
      name: overrides.name,
      base_token_price_usd: overrides.priceUsd ?? '0.000001',
      quote_token_price_usd: '1',
      reserve_in_usd: overrides.reserveUsd ?? '100000',
      volume_usd: overrides.volumeUsd ?? '50000',
      fdv_usd: overrides.fdvUsd ?? '1000000',
      price_change_percentage_h24: '5.5',
    },
    relationships: {
      base_token: { data: { id: `${overrides.address}` } },
      network: { data: { id: `${overrides.network}` } },
    },
  };
}

/** Build a fetch stub that answers every URL with the given pool rows.
 *  `onFetch` runs at each fetch entry (used to record pacing timestamps). */
function fetchStub(rows: unknown[], onFetch?: () => void) {
  let calls = 0;
  const fn = async (url: string) => {
    calls += 1;
    onFetch?.();
    return { ok: true, status: 200, json: async () => ({ data: rows }) };
  };
  return { fn, count: () => calls };
}

const OLD_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('GeckoDiscoveryFeed (SRC-153 keyless discovery tier)', () => {
  it('normalizes new_pools + trending_pools across all five chains', async () => {
    const { fn } = fetchStub([poolRow({ address: '0xAAA', name: 'PEPE / WETH', network: 'base' })]);
    const feed = new GeckoDiscoveryFeed({ fetch: fn, minIntervalMs: 0 });
    const tokens = await feed.discover();
    // Five chains x both endpoints -> base pool row present once (deduped)
    expect(tokens.length).toBeGreaterThan(0);
    const pepe = tokens.find((t) => t.symbol === 'PEPE' && t.chainId === 8453);
    expect(pepe).toBeDefined();
    expect(pepe!.address).toBe('0xAAA');
    expect(pepe!.chainId).toBe(8453); // base
    expect(pepe!.liquidityUsd).toBe(100000);
    expect(pepe!.volume24hUsd).toBe(50000);
    expect(pepe!.priceUsd).toBeGreaterThan(0);
  });

  it('maps all supported networks to distinct chain ids (geckoNetworkIdFor owner)', async () => {
    // The old version of this test named the mapping but stubbed an EMPTY
    // response and asserted `[] === []` — it never touched the mapper. These
    // two real callers (robinhood-screening-agent, cli/calibrate) resolve a
    // network per row, so assert one resolved id per network.
    const { fn } = fetchStub([
      poolRow({ address: '0xSOL', name: 'A', network: 'solana' }),
      poolRow({ address: '0xBSC', name: 'B', network: 'bsc' }),
      poolRow({ address: '0xBASE', name: 'C', network: 'base' }),
      poolRow({ address: '0xETH', name: 'D', network: 'eth' }),
      poolRow({ address: '0xRH', name: 'E', network: 'robinhood' }),
    ]);
    const feed = new GeckoDiscoveryFeed({ fetch: fn, minIntervalMs: 0 });
    const tokens = await feed.discover();
    const bySymbol = new Map(tokens.map((t) => [t.symbol, t.chainId]));
    expect(bySymbol.get('A')).toBe(101);      // solana
    expect(bySymbol.get('B')).toBe(56);       // bsc
    expect(bySymbol.get('C')).toBe(8453);     // base
    expect(bySymbol.get('D')).toBe(1);        // eth
    expect(bySymbol.get('E')).toBe(4663);     // robinhood
  });

  it('handles Solana (non-EVM) token ids without 0x and with the solana network id', async () => {
    const { fn } = fetchStub([poolRow({ address: 'So11111111111111111111111111111111111111112', name: 'SOL / USDC', network: 'solana' })]);
    const feed = new GeckoDiscoveryFeed({ fetch: fn, minIntervalMs: 0 });
    const tokens = await feed.discover();
    const sol = tokens.find((t) => t.symbol === 'SOL');
    expect(sol).toBeDefined();
    expect(sol!.address).toBe('So11111111111111111111111111111111111111112');
    expect(sol!.chainId).toBe(101); // solana in CHAIN_NAME_TO_ID
  });

  it('applies chainId / minLiquidity / sort / limit options', async () => {
    const { fn } = fetchStub([
      poolRow({ address: '0xBBB', name: 'BIG / WETH', network: 'base', reserveUsd: '1000000' }),
      poolRow({ address: '0xCCC', name: 'SMALL / WETH', network: 'base', reserveUsd: '1000' }),
    ]);
    const feed = new GeckoDiscoveryFeed({ fetch: fn, minIntervalMs: 0 });
    const tokens = await feed.discover({ chainIds: [8453], minLiquidityUsd: 10000, sort: 'liquidityUsd', limit: 1 });
    expect(tokens).toHaveLength(1);
    expect(tokens[0].symbol).toBe('BIG');
  });

  it('paces requests: minIntervalMs elapses between fetches (30/min budget)', async () => {
    // The previous version of this test advanced a fake clock from a real
    // setInterval racing the awaits, then only asserted count() > 0 — it passed
    // unchanged if the minIntervalMs wait in pacedGetPoolRows was deleted. This
    // records the clock at each fetch entry and asserts the real spacing, with
    // no timers and no wall-clock flake. A live 429 was observed on Gecko
    // precisely because freshPools/trendingPools were parallelized past this.
    const stamps: number[] = [];
    let now = 0;
    const { fn } = fetchStub([poolRow({ address: '0xDDD', name: 'PACE / WETH', network: 'bsc' })], () => stamps.push(now));
    const feed = new GeckoDiscoveryFeed({ fetch: fn, minIntervalMs: 500, now: () => now });
    // Advance past the first wait so each subsequent fetch must re-wait.
    const p1 = feed.discover();
    const tick = setInterval(() => { now += 1000; }, 1);
    try {
      const tokens = await p1;
      expect(tokens.length).toBeGreaterThan(0);
      expect(stamps.length).toBeGreaterThan(1);
      for (let i = 1; i < stamps.length; i++) {
        expect(stamps[i]! - stamps[i - 1]!).toBeGreaterThanOrEqual(500);
      }
    } finally {
      clearInterval(tick);
    }
  });

  it('fails open (empty) on HTTP error and logs a warn', async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      const feed = new GeckoDiscoveryFeed({
        fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
        minIntervalMs: 0,
      });
      const tokens = await feed.discover();
      expect(tokens).toEqual([]);
      expect(warnings.some((w) => w.includes('GECKO FEED') && w.includes('skipped'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it('caches per chain+endpoint (no refetch within ttl)', async () => {
    const { fn, count } = fetchStub([poolRow({ address: '0xEEE', name: 'CACHE / WETH', network: 'base' })]);
    const feed = new GeckoDiscoveryFeed({ fetch: fn, minIntervalMs: 0, ttlMs: 60_000 });
    const first = await feed.discover();
    const second = await feed.discover();
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    // Item 3: all-network endpoints collapse the fan-out — 2 calls (new_pools
    // + trending_pools for ALL chains), not 10 (5 chains x 2 endpoints). The
    // TTL cache then absorbs repeat discovers entirely.
    expect(count()).toBe(2);
  });
});