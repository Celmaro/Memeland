import { describe, it, expect, vi, afterEach } from 'vitest';
import { GMGNAdapter } from '../src/adapters/gmgn-adapter.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GMGN_API_KEY;
  delete process.env.GMGN_BACKUP_KEYS;
  delete process.env.GMGN_REQUEST_SPACING_MS;
});

interface Raw {
  chain: string;
  address: string;
  symbol: string;
  name: string;
  price: number;
  market_cap: number;
  volume: number;
  liquidity: number;
}

function rankPayload(chain: string, tokens: Raw[]) {
  return {
    code: 0,
    data: {
      data: {
        rank: tokens.map((t) => ({ ...t, chain })),
      },
    },
  };
}

/** Stub global fetch to return a per-chain rank payload, tracking requested chains. */
function stubRank(byChain: Record<string, Raw[]>, requested: string[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const chain = new URL(url).searchParams.get('chain') || '';
      requested.push(chain);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => rankPayload(chain, byChain[chain] || []),
      };
    })
  );
}

const SOL_TOKENS: Raw[] = [
  { chain: 'sol', address: '0xaaa', symbol: 'SOLA', name: 'Sol A', price: 0.01, market_cap: 100000, volume: 500, liquidity: 10000 },
  { chain: 'sol', address: '0xbbb', symbol: 'SOLB', name: 'Sol B', price: 0.02, market_cap: 50000, volume: 300, liquidity: 5000 },
];

// Same address as SOLA — must survive as a separate cross-chain identity.
const BSC_TOKENS: Raw[] = [
  { chain: 'bsc', address: '0xaaa', symbol: 'BSCA', name: 'Bsc A', price: 0.05, market_cap: 200000, volume: 900, liquidity: 20000 },
];

describe('GMGNAdapter.discover (MarketDataProvider)', () => {
  it('aggregates only requested chains and keeps cross-chain addresses separate', async () => {
    process.env.GMGN_API_KEY = 'test-key';
    process.env.GMGN_REQUEST_SPACING_MS = '100';
    const requested: string[] = [];
    stubRank({ sol: SOL_TOKENS, bsc: BSC_TOKENS }, requested);

    const tokens = await new GMGNAdapter().discover({ chainIds: [101, 56] });

    expect(requested.sort()).toEqual(['bsc', 'sol']);
    expect(tokens.map((t) => `${t.chainId}:${t.symbol}`).sort()).toEqual([
      '101:SOLA',
      '101:SOLB',
      '56:BSCA',
    ]);
    const bscA = tokens.find((t) => t.chainId === 56);
    expect(bscA).toMatchObject({
      address: '0xaaa',
      symbol: 'BSCA',
      name: 'Bsc A',
      priceUsd: 0.05,
      liquidityUsd: 20000,
      volume24hUsd: 900,
      mcapUsd: 200000,
    });
  });

  it('applies minLiquidityUsd, sort by volume24hUsd and limit', async () => {
    process.env.GMGN_API_KEY = 'test-key';
    process.env.GMGN_REQUEST_SPACING_MS = '100';
    stubRank({ sol: SOL_TOKENS, bsc: BSC_TOKENS }, []);

    const tokens = await new GMGNAdapter().discover({
      chainIds: [101, 56],
      minLiquidityUsd: 8000,
      sort: 'volume24hUsd',
      limit: 2,
    });

    expect(tokens).toHaveLength(2);
    // 56:BSCA (volume 900) first, then 101:SOLA (volume 500). SOLB (300) filtered by limit.
    expect(tokens[0].volume24hUsd).toBe(900);
    expect(tokens[1].volume24hUsd).toBe(500);
  });

  it('defaults to all discovery chains (robinhood included)', async () => {
    process.env.GMGN_API_KEY = 'test-key';
    process.env.GMGN_REQUEST_SPACING_MS = '100';
    const requested: string[] = [];
    stubRank({ robinhood: [{ chain: 'robinhood', address: '0xrh', symbol: 'RHA', name: 'RH A', price: 0.1, market_cap: 300000, volume: 1000, liquidity: 40000 }] }, requested);

    const tokens = await new GMGNAdapter().discover();

    expect(requested).toEqual(['robinhood', 'sol', 'bsc', 'base']);
    expect(tokens.map((t) => t.chainId)).toEqual([4663]);
  });
});
