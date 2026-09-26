import { TtlCache } from '../cache/ttl-cache.js';
import { StalenessClock } from '../clock/staleness-clock.js';

export class PriceFeedService {
  private readonly prices: TtlCache<number>;
  private readonly changes: TtlCache<number>;
  private readonly freshness: StalenessClock;
  private readonly cacheDurationMs: number;

  private symbolToGeckoId: Record<string, string> = {
    BTC: 'bitcoin',
    ETH: 'ethereum',
    USDC: 'usd-coin',
    BONK: 'bonk',
    PEPE: 'pepe',
    WIF: 'dogwifcoin',
    DOGE: 'dogecoin',
    AVAX: 'avalanche-2',
    SUI: 'sui',
    LINK: 'chainlink',
  };

  constructor(opts: { cacheDurationMs?: number; now?: () => number } = {}) {
    this.cacheDurationMs = opts.cacheDurationMs ?? 60_000;
    this.prices = new TtlCache<number>({ ttlMs: this.cacheDurationMs, now: opts.now });
    this.changes = new TtlCache<number>({ ttlMs: this.cacheDurationMs, now: opts.now });
    this.freshness = new StalenessClock({ ttlMs: this.cacheDurationMs, now: opts.now });
  }

  public async getPrice(symbol: string): Promise<number | null> {
    const cleanSymbol = symbol.toUpperCase().trim();
    const geckoId = this.symbolToGeckoId[cleanSymbol];
    if (!geckoId) {
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
    const geckoId = this.symbolToGeckoId[cleanSymbol];
    if (!geckoId) return null;
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
      const ids = Object.values(this.symbolToGeckoId).join(',');
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`CoinGecko HTTP error: ${response.status}`);
      }
      const data = (await response.json()) as Record<string, { usd?: number; usd_24h_change?: number }>;
      for (const [symbol, geckoId] of Object.entries(this.symbolToGeckoId)) {
        const price = data[geckoId]?.usd;
        if (typeof price === 'number' && price > 0) {
          this.prices.set(symbol, price);
        }
        const change = data[geckoId]?.usd_24h_change;
        if (typeof change === 'number') {
          this.changes.set(symbol, change);
        }
      }
      this.freshness.touch();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Item 2: CoinGecko is a single point of failure for the fee gate — when
      // it 429s or goes stale, EVERY token with a fee fails "live price
      // unavailable". Fall back to the public exchange tickers (Binance →
      // Coinbase) so ETH/SOL/BTC prices keep flowing. Fail-soft: if all three
      // fail, the gate stays fail-closed (correct) but the operator sees which
      // fallback worked.
      console.warn(`[PRICE SERVICE ERROR] CoinGecko failed (${message}) — trying exchange fallbacks.`);
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