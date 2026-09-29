import { TtlCache } from '../cache/ttl-cache.js';
import { StalenessClock } from '../clock/staleness-clock.js';

export class PriceFeedService {
  private readonly prices: TtlCache<number>;
  private readonly changes: TtlCache<number>;
  private readonly freshness: StalenessClock;
  private readonly cacheDurationMs: number;

  /**
   * Symbol -> GeckoTerminal simple-price reference.
   *
   * GeckoTerminal's simple-price endpoint is ADDRESS-keyed per NETWORK (unlike
   * CoinGecko's coin-ID-keyed /simple/price): you call
   *   /simple/networks/{network}/token_price/{addresses}
   * and the response keys prices by token contract address. So each supported
   * symbol must map to the concrete on-chain contract we want to price.
   *
   * EVM addresses are stored lower-case (GeckoTerminal echoes them lower-case;
   * Solana base58 is case-sensitive and kept verbatim). We intentionally DROP
   * DOGE and SUI: they are L1 native assets with no canonical GeckoTerminal
   * token-contract address, so there is nothing to price here (they resolve
   * to null, same as CoinGecko's 403 already did). The fee-gate-critical
   * symbols (BTC/ETH/SOL) are still covered — BTC/ETH via wrapped contracts
   * here, SOL via the exchange-ticker fallback below.
   */
  private symbolRefs: Record<string, { network: string; address: string }> = {
    BTC: { network: 'eth', address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' }, // WBTC
    ETH: { network: 'eth', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' }, // WETH
    USDC: { network: 'eth', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
    PEPE: { network: 'eth', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933' },
    LINK: { network: 'eth', address: '0x514910771af9ca656af840dff83e8264ecf986ca' },
    AVAX: { network: 'avax', address: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7' }, // WAVAX
    BONK: { network: 'solana', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    WIF: { network: 'solana', address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  };

  constructor(opts: { cacheDurationMs?: number; now?: () => number } = {}) {
    this.cacheDurationMs = opts.cacheDurationMs ?? 60_000;
    this.prices = new TtlCache<number>({ ttlMs: this.cacheDurationMs, now: opts.now });
    this.changes = new TtlCache<number>({ ttlMs: this.cacheDurationMs, now: opts.now });
    this.freshness = new StalenessClock({ ttlMs: this.cacheDurationMs, now: opts.now });
  }

  public async getPrice(symbol: string): Promise<number | null> {
    const cleanSymbol = symbol.toUpperCase().trim();
    if (!this.symbolRefs[cleanSymbol]) {
      console.warn(`[PRICE SERVICE] Unsupported symbol "${symbol}" — returning null.`);
      return null;
    }
    if (this.freshness.isStale() || this.prices.size() === 0) {
      await this.refreshPrices();
    }
    return this.prices.get(cleanSymbol) ?? null;
  }

  public async get24hChange(symbol: string): Promise<number | null> {
    const cleanSymbol = symbol.toUpperCase().trim();
    if (!this.symbolRefs[cleanSymbol]) return null;
    if (this.freshness.isStale() || this.changes.size() === 0) {
      await this.refreshPrices();
    }
    return this.changes.get(cleanSymbol) ?? null;
  }

  /** Diagnostics — exposes the freshness clock + cache sizes. */
  public snapshot(): { isFresh: boolean; ageMs: number | null; priceCount: number } {
    return {
      isFresh: !this.freshness.isStale() && this.prices.size() > 0,
      ageMs: this.freshness.ageMs(),
      priceCount: this.prices.size(),
    };
  }

  private async refreshPrices(): Promise<void> {
    try {
      // GeckoTerminal simple-price is PER-NETWORK: one call returns prices for
      // addresses on a single network. Group symbol refs by network so each
      // network needs exactly one request (addresses are comma-joined, up to
      // 100). We fire the network calls sequentially, not Promise.all — they
      // share the keyless 30/min budget, and concurrent loops would collapse
      // pacing and trip a 429 (same failure mode the discovery feed documents).
      const byNetwork = new Map<string, Array<{ symbol: string; address: string }>>();
      for (const [symbol, ref] of Object.entries(this.symbolRefs)) {
        const list = byNetwork.get(ref.network) ?? [];
        list.push({ symbol, address: ref.address });
        byNetwork.set(ref.network, list);
      }
      for (const [network, entries] of byNetwork) {
        const addresses = entries.map((e) => e.address).join(',');
        const url = `https://api.geckoterminal.com/api/v2/simple/networks/${network}/token_price/${addresses}?include_24hr_price_change=true`;
        const response = await fetch(url, {
          headers: { Accept: 'application/json;version=20230203' },
        });
        if (!response.ok) {
          console.warn(`[PRICE SERVICE] GeckoTerminal ${network} HTTP error: ${response.status}`);
          continue; // try the next network; missing networks stay null
        }
        const body = (await response.json()) as {
          data?: { attributes?: { token_prices?: Record<string, string>; h24_price_change_percentage?: Record<string, string> } };
        };
        const prices = body?.data?.attributes?.token_prices ?? {};
        const changes = body?.data?.attributes?.h24_price_change_percentage ?? {};
        for (const { symbol, address } of entries) {
          const price = Number(prices[address]);
          if (Number.isFinite(price) && price > 0) this.prices.set(symbol, price);
          const change = Number(changes[address]);
          if (Number.isFinite(change)) this.changes.set(symbol, change);
        }
      }
      this.freshness.touch();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Item 2: a single price provider is a point of failure for the fee gate
      // — when it 429s (keyless 30/min budget) or goes stale, EVERY token with
      // a fee fails "live price unavailable". Fall back to the public exchange
      // tickers (Binance → Coinbase) so ETH/SOL/BTC prices keep flowing.
      // Fail-soft: if all sources fail, the gate stays fail-closed (correct)
      // but the operator sees which fallback worked.
      console.warn(`[PRICE SERVICE ERROR] GeckoTerminal failed (${message}) — trying exchange fallbacks.`);
      await this.refreshFromExchangeFallbacks();
    }
  }

  /**
   * Item 2: exchange-ticker fallback for the native-symbol prices the fee gate
   * needs (BTC/ETH/SOL). Binance public API first, then Coinbase. Each feeds
   * the same TTL cache + freshness clock so a partial recovery still unsticks
   * the gate. 24h change is not available from these tickers — it stays null.
   */
  private async refreshFromExchangeFallbacks(): Promise<void> {
    const binanceSymbols: Record<string, string> = { BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT' };
    const coinbaseSymbols: Record<string, string> = { BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD' };
    let any = false;
    // Binance: GET /api/v3/ticker/price?symbol=BTCUSDT — keyless public.
    for (const [symbol, pair] of Object.entries(binanceSymbols)) {
      try {
        const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
        if (res.ok) {
          const data = (await res.json()) as { price?: string };
          const price = Number(data.price);
          if (Number.isFinite(price) && price > 0) {
            this.prices.set(symbol, price);
            this.changes.set(symbol, 0); // no change from tickers; neutral
            any = true;
          }
        }
      } catch { /* next fallback */ }
    }
    // Coinbase: GET /v2/prices/{pair}/spot — keyless public.
    if (!any) {
      for (const [symbol, pair] of Object.entries(coinbaseSymbols)) {
        try {
          const res = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`);
          if (res.ok) {
            const data = (await res.json()) as { data?: { amount?: string } };
            const price = Number(data?.data?.amount);
            if (Number.isFinite(price) && price > 0) {
              this.prices.set(symbol, price);
              this.changes.set(symbol, 0);
              any = true;
            }
          }
        } catch { /* last resort */ }
      }
    }
    if (any) {
      this.freshness.touch();
      console.log('[PRICE SERVICE] Exchange fallback prices loaded (gate unstuck).');
    } else {
      console.warn('[PRICE SERVICE] All price sources failed — fee gate remains fail-closed.');
    }
  }
}

/** Process-wide singleton: the cache is global state — every consumer must share ONE instance. */
export const globalPriceFeedService = new PriceFeedService();