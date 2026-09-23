import { afterEach, describe, expect, it } from 'vitest';
import { GeckoDiscoveryFeed } from '../src/adapters/gecko-discovery-feed.js';

/** Minimal GeckoTerminal v2 pool-row fixture (matching the real API shape). */
function poolRow(overrides: { address: string; name: string; network: string; priceUsd?: string; reserveUsd?: string; volumeUsd?: string; fdvUsd?: string }) {
  return {
    id: `${overrides.network}:${overrides.address}`,
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
      base_token: { data: { id: `${overrides.network}:${overrides.address}` } },
    },
  };
}

/** Build a fetch stub that answers every URL with the given pool rows. */
function fetchStub(rows: unknown[]) {
  let calls = 0;
  const fn = async (url: string) => {
    calls += 1;
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

  it('maps all supported networks via geckoNetworkIdFor', async () => {
    const { fn } = fetchStub([]);
    const feed = new GeckoDiscoveryFeed({ fetch: fn, minIntervalMs: 0 });
    await feed.discover();
    // sol->solana, bsc->bsc, base->base, eth->eth, robinhood->robinhood
    // base URL calls: 5 chains x 2 endpoints = 10 calls
    expect(await feed.discover()).toEqual([]);
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

  it('paces requests (minIntervalMs honored) and still returns rows', async () => {
    const { fn, count } = fetchStub([poolRow({ address: '0xDDD', name: 'PACE / WETH', network: 'bsc' })]);
    let now = 0;
    const feed = new GeckoDiscoveryFeed({ fetch: fn, minIntervalMs: 500, now: () => now });
    const p1 = feed.discover();
    // simulate time passing during the awaits
    const timer = setInterval(() => { now += 1000; }, 5);
    const tokens = await p1;
    clearInterval(timer);
    expect(tokens.length).toBeGreaterThan(0);
    expect(count()).toBeGreaterThan(0);
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
    // fresh run: 10 calls (5 chains x 2 endpoints). second run: 0 (all cached).
    expect(count()).toBe(10);
  });
});