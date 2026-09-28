import { describe, it, expect } from 'vitest';
import { FomoApiClient } from './fomo-api.js';
import { ProviderGovernor } from '../services/provider-governor.js';

function stubFetch(respond: (url: string) => { status: number; json: unknown; credit?: string }) {
  return (url: string, _init?: RequestInit): Promise<unknown> => {
    const hit = respond(url);
    return Promise.resolve({
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      json: () => Promise.resolve(hit.json),
      headers: new Headers(hit.credit ? { 'x-credits-cost': hit.credit } : {}),
    });
  };
}

const gov = (): ProviderGovernor => new ProviderGovernor();

describe('FomoApiClient', () => {
  it('parses a leaderboard row into wallets + pnl + volume', async () => {
    const fetch = stubFetch(() => ({
      status: 200,
      json: { data: [{ rank: 1, handle: 'whale0', userId: 'u1', pnlPct: 42.5, volumeUsd: 1000, solWallet: 'solAAAA', evmWallet: '0x123', chain: 'robinhood' }] },
      credit: '250',
    }));
    const c = new FomoApiClient({ apiKey: 'k', baseUrl: 'https://app.fomoapi.io', fetch: fetch as unknown as typeof globalThis.fetch, governor: gov() });
    const rows = await c.leaderboard('24h', 'robinhood');
    expect(rows).toHaveLength(1);
    expect(rows[0].handle).toBe('whale0');
    expect(rows[0].solWallet).toBe('solAAAA');
    expect(rows[0].pnlPct).toBe(42.5);
    expect(rows[0].chain).toBe('robinhood');
  });

  it('parses a token board into token candidate hints', async () => {
    const fetch = stubFetch(() => ({
      status: 200,
      json: { tokens: [{ address: '0xbeef', symbol: 'BEEF', priceUsd: 0.001, change24hPct: 200, volumeUsd: 5000, chain: 'base' }] },
    }));
    const c = new FomoApiClient({ apiKey: 'k', baseUrl: 'https://app.fomoapi.io', fetch: fetch as unknown as typeof globalThis.fetch, governor: gov() });
    const rows = await c.tokenBoard('trending', 'base');
    expect(rows[0].address).toBe('0xbeef');
    expect(rows[0].change24hPct).toBe(200);
    expect(rows[0].chain).toBe('base');
  });

  it('is fail-soft: empty on transport/parse error, never throws', async () => {
    const fetch = stubFetch(() => {
      throw new Error('boom');
    });
    const c = new FomoApiClient({ apiKey: 'k', baseUrl: 'https://app.fomoapi.io', fetch: fetch as unknown as typeof globalThis.fetch, governor: gov() });
    const rows = await c.leaderboard('24h');
    expect(rows).toEqual([]);
  });
});