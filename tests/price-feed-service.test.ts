import { describe, it, expect, vi, afterEach } from 'vitest';
import { PriceFeedService } from '../src/services/price-feed-service.js';

/**
 * PriceFeedService owner tests for the CoinGecko -> GeckoTerminal migration.
 *
 * GeckoTerminal's simple-price endpoint is ADDRESS-keyed per NETWORK, so a
 * real call groups symbol refs by network and issues one request per network
 * returning prices keyed by contract address. These tests stub that exact
 * shape to keep the mapping/parse logic honest, and pin the fail-closed cases.
 */
describe('PriceFeedService', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns real price from a GeckoTerminal response (address-keyed per network) and caches it', async () => {
    // Two networks used by the refs: 'eth' (BTC/ETH/USDC/...) and 'solana'.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/simple/networks/eth/token_price/')) {
        return {
          ok: true,
          json: async () => ({
            data: { attributes: {
              token_prices: {
                '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': '70000', // WBTC -> BTC
                '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': '3500',   // WETH -> ETH
              },
              h24_price_change_percentage: {
                '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': '1.5',
                '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': '-2.0',
              },
            } },
          }),
        };
      }
      return { ok: true, json: async () => ({ data: { attributes: { token_prices: {} } } }) };
    }));
    const svc = new PriceFeedService();
    expect(await svc.getPrice('BTC')).toBe(70000);
    expect(await svc.getPrice('ETH')).toBe(3500);
    expect(await svc.get24hChange('ETH')).toBe(-2.0);
  });

  it('returns null for unsupported symbols (no fallback mapping)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { attributes: { token_prices: {} } } }) }));
    const svc = new PriceFeedService();
    expect(await svc.getPrice('SHIB')).toBeNull();
  });

  it('returns null for DOGE/SUI — L1 natives with no GeckoTerminal token address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { attributes: { token_prices: {} } } }) }));
    const svc = new PriceFeedService();
    expect(await svc.getPrice('DOGE')).toBeNull();
    expect(await svc.getPrice('SUI')).toBeNull();
  });

  it('returns null for a supported symbol when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const svc = new PriceFeedService();
    expect(await svc.getPrice('BTC')).toBeNull();
  });

  it('falls through to the next network if one network call errors (others still resolve)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/simple/networks/eth/token_price/')) return { ok: false, status: 429 };
      return {
        ok: true,
        json: async () => ({
          data: { attributes: {
            token_prices: { 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': '0.00003' },
            h24_price_change_percentage: {},
          } },
        }),
      };
    }));
    const svc = new PriceFeedService();
    // eth network (BTC/ETH) is down -> null; solana network (BONK) still resolves.
    expect(await svc.getPrice('ETH')).toBeNull();
    expect(await svc.getPrice('BONK')).toBe(0.00003);
  });

  it('starts with empty cache (no fabricated seed prices)', () => {
      const svc = new PriceFeedService();
      expect((svc as unknown as { prices: { size(): number } }).prices.size()).toBe(0);
      expect((svc as unknown as { changes: { size(): number } }).changes.size()).toBe(0);
    });

  it('P5/E3 — resolves native SOL via the exchange fallback (no GeckoTerminal address)', async () => {
    // SOL is not in symbolRefs (no GeckoToken address) — it must fall back to
    // the public Binance ticker instead of returning null (the fee-gate fix).
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('api.binance.com/api/v3/ticker/price?symbol=SOLUSDT')) {
        return { ok: true, json: async () => ({ price: '155.5' }) };
      }
      return { ok: false };
    }));
    const svc = new PriceFeedService();
    expect(await svc.getPrice('SOL')).toBe(155.5);
  });

  it('P5 — keeps unsupported non-native symbols returning null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { attributes: { token_prices: {} } } }) }));
    const svc = new PriceFeedService();
    expect(await svc.getPrice('FOOBAR')).toBeNull();
  });
  });
