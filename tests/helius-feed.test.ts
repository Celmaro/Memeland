import { describe, it, expect } from 'vitest';
import { HeliusFeed, HELIUS_RPC_BASE } from '../src/adapters/helius-feed.js';
import type { FetchLike } from '../src/adapters/helius-feed.js';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('HeliusFeed (P4.3 SOL security via DAS getTokenAccounts)', () => {
  it('extracts holder count, top-10 concentration, and mint/freeze authority', async () => {
    let body = '';
    const fn: FetchLike = async (url: string, init?: { body?: string }) => {
      body = init?.body ?? '';
      return okJson({
        result: {
          mintAuthority: true, // mutable mint authority = rug risk
          freezeAuthority: true,
          items: [
            { owner: '0xA', amount: 5000 },
            { owner: '0xB', amount: 2500 },
            { owner: '0xC', amount: 1000 },
            { owner: '0xD', amount: 1000 },
            { owner: '0xE', amount: 500 },
          ],
        },
      });
    };
    const feed = new HeliusFeed({ fetch: fn, apiKey: 'test-key' });
    const r = await feed.tokenAccounts('SoMint');
    expect(body).toContain('getTokenAccounts');
    expect(r).not.toBeNull();
    expect(r!.count).toBe(5);
    expect(r!.top10Percent).toBeGreaterThan(0);
    expect(r!.mintAuthorityMutable).toBe(true); // rug risk detected
    expect(r!.freezeAuthorityMutable).toBe(true);
  });

  it('fails soft on RPC error (never blocks the funnel)', async () => {
    const fn: FetchLike = async () => { throw new Error('rpc down'); };
    const feed = new HeliusFeed({ fetch: fn, apiKey: 'k' });
    expect(await feed.tokenAccounts('SoMint')).toBeNull();
  });
});
