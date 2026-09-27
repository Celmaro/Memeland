import { describe, it, expect } from 'vitest';
import { CmcDexFeed, CMC_PRO_BASE } from '../src/adapters/cmc-dex-feed.js';
import type { FetchLike } from '../src/adapters/cmc-dex-feed.js';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('CmcDexFeed (P4.1 free keyless DEX stack)', () => {
  it('discovers newest DEX spot pairs with pool_created (new-pair walking)', async () => {
    let called = '';
    const fn: FetchLike = async (url: string) => {
      called = url;
      return ok({
        data: [{
          pool_id: '0xP1',
          base_asset: { contract_address: '0xTOKEN', name: 'PEPE', symbol: 'PEPE' },
          network_id: 'base',
          price: 0.0012,
          liquidity: 25000,
          volume_24h: 50000,
          pool_created: '2026-09-27T18:47:00Z',
        }],
      });
    };
    const feed = new CmcDexFeed({ fetch: fn });
    const tokens = await feed.discover({ chainIds: [8453] });
    expect(called).toContain('/v4/dex/spot-pairs/latest');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.address).toBe('0xTOKEN');
    expect(tokens[0]!.symbol).toBe('PEPE');
    expect(tokens[0]!.chainId).toBe(8453);
    expect(tokens[0]!.freshLane).toBe(true); // pool_created-ordered = fresh
  });

  it('enriches holder count via /v1/dex/holders/count (works on Solana)', async () => {
    let called = '';
    const fn: FetchLike = async (url: string) => {
      called = url;
      return ok({ data: { holder_count: 412, distribution: { top_10_percent: 21.5 } } });
    };
    const feed = new CmcDexFeed({ fetch: fn });
    const h = await feed.fetchHolders('solana', 'SoMint');
    expect(called).toContain('/v1/dex/holders/count');
    expect(h?.count).toBe(412);
    expect(h?.top10Percent).toBeCloseTo(21.5);
  });

  it('returns empty on transport failure (fail-soft)', async () => {
    const fn: FetchLike = async () => { throw new Error('down'); };
    const feed = new CmcDexFeed({ fetch: fn });
    const tokens = await feed.discover({ chainIds: [1] });
    expect(tokens).toEqual([]);
  });
});
