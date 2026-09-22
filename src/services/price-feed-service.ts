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
      console.warn(`[PRICE SERVICE ERROR] Failed to fetch prices: ${message}`);
    }
  }
}

/** Process-wide singleton: the cache is global state — every consumer must share ONE instance. */
export const globalPriceFeedService = new PriceFeedService();