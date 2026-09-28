import { describe, it, expect, afterEach, vi } from 'vitest';
import { SolanaTrackerFeed, SOLANATRACKER_BASE } from './solanatracker-feed.js';
import { ProviderGovernor } from '../services/provider-governor.js';

type JsonResponse = { status: number; json: () => Promise<unknown> };
const okJson = (data: unknown, status = 200): JsonResponse => ({ status, json: async () => data });

let fetchMock: ReturnType<typeof vi.fn>;

const feedWith = (urlToJson: (url: string) => JsonResponse) => {
  fetchMock = vi.fn((url: string) => Promise.resolve(urlToJson(String(url))));
  return new SolanaTrackerFeed({
    apiKey: 'k',
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    governor: new ProviderGovernor(),
    dailyCap: 300,
    rpm: 3,
  });
};

describe('SolanaTrackerFeed (enricher)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('discover normalizes latest tokens to MarketToken[] (Sol)', async () => {
    const f = feedWith((url) =>
      okJson({
        tokens: [
          { tokenAddress: 'aa111111111111111111111111111111111111111', symbol: 'TKN', name: 'Test', price: 0.5, liquidity: 1000, volume: 5000, fdv: 100000, priceChange24h: 0.12 },
        ],
      }),
    );
    const out = await f.discover();
    expect(out).toHaveLength(1);
    expect(out[0]!.chainId).toBe(101);
    expect(out[0]!.symbol).toBe('TKN');
    expect(out[0]!.priceUsd).toBe(0.5);
    expect(out[0]!.liquidityUsd).toBe(1000);
    expect(out[0]!.change24hPct).toBe(0.12);
    expect(fetchMock).toHaveBeenCalledWith(
      `${SOLANATRACKER_BASE}/tokens/latest?network=solana`,
      expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'k' }) }),
    );
  });

  it('discover filters to Sol: returns [] when chainIds exclude Sol', async () => {
    const f = feedWith(() => okJson({ tokens: [] }));
    const out = await f.discover({ chainIds: [56] });
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is fail-soft: empty [] on transport error, does not throw', async () => {
    const f = feedWith(() => {
      throw new Error('boom');
    });
    await expect(f.discover()).resolves.toEqual([]);
  });

  it('is fail-soft: empty [] on 429', async () => {
    const f = feedWith(() => okJson({}, 429));
    await expect(f.discover()).resolves.toEqual([]);
  });

  it('tokenDetail returns short-window volume for a Sol address', async () => {
    const f = feedWith(() => okJson({ volume1h: 123, buy: 80, sell: 43 }));
    const d = await f.tokenDetail('sol', 'aa111111111111111111111111111111111111111');
    expect(d).toEqual({ volume1hUsd: 123, buyUsd1h: 80, sellUsd1h: 43 });
  });

  it('tokenDetail returns null for a non-Sol chain', async () => {
    const f = feedWith(() => okJson({ volume1h: 1 }));
    expect(await f.tokenDetail('eth', '0xabc')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});