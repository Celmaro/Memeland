import { describe, it, expect } from 'vitest';
import { DeFiLlamaRegimeFeed } from './defillama-feed.js';

function route(url: string) {
  let tvl: unknown = [];
  if (url.includes('/v2/chains')) {
    tvl = [
      { name: 'Ethereum', tvl: 60e9, change_1d: 0.02 },
      { name: 'Solana', tvl: 30e9, change_1d: 0.05 },
    ];
  }
  return { ok: true, status: 200, json: async () => tvl };
}

const routeFetch = (url: unknown): Promise<unknown> => Promise.resolve(route(String(url)));

describe('DeFiLlamaRegimeFeed', () => {
  it('serves a per-chain regime snapshot when the chain exists', async () => {
    const f = new DeFiLlamaRegimeFeed({ chainName: 'Solana', fetch: routeFetch as unknown as typeof globalThis.fetch });
    const r = await f.regime({ chainName: 'Solana' });
    expect(r.healthy).toBe(true);
    expect(r.tvlUsd).toBe(30e9);
    expect(r.change24hPct).toBe(0.05);
  });

  it('is fail-soft: returns a neutral healthy:false regime on transport error', async () => {
    const badFetch = async (): Promise<unknown> => {
      throw new Error('boom');
    };
    const f = new DeFiLlamaRegimeFeed({ fetch: badFetch as unknown as typeof globalThis.fetch });
    const r = await f.regime();
    expect(r.healthy).toBe(false);
    expect(r.tvlUsd).toBe(0);
  });

  it('computes a TVL-weighted aggregate change and top chains', async () => {
    const f = new DeFiLlamaRegimeFeed({ fetch: routeFetch as unknown as typeof globalThis.fetch });
    const r = await f.regime();
    expect(r.healthy).toBe(true);
    expect(r.topChains).toHaveLength(2);
    // (60e9*0.02 + 30e9*0.05) / 90e9 = (1.2e9 + 1.5e9)/90e9 = 0.03
    expect(r.change24hPct).toBeCloseTo(0.03, 5);
  });
});