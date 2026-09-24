/**
 * I2-2 — DexScreener boosts/ads feed (direct, vendor-free paid-hype signal).
 *
 * The sentiment voter's paid-hype signal currently comes from GMGN's
 * `dexscr_boost_fee` proxy — second-hand and 429-vulnerable. This adapter reads
 * DexScreener's OWN boost/ads endpoints directly, so paid-hype is a first-class,
 * keyless, vendor-independent source.
 *
 * Semantics (deep-review): a boost/ad is a PROMOTION signal, NOT evidence of
 * organic demand. It must be kept separate from organic sentiment and CAPPED so
 * it can never independently lift a candidate over a hard security/liquidity
 * gate. Consumers use `paidBoost` as a separate field; the sentiment voter
 * already treats paid hype as capped + contradiction-eligible.
 *
 * Env-gate: DEXSCREENER_BOOSTS_ENABLED=true. Fail-open: any error → [].
 */

import type { MarketDataProvider, MarketDiscoveryOptions, MarketToken } from './market-data-provider.js';

type FetchLike = (url: string) => Promise<Pick<Response, 'ok' | 'json'>>;

export interface BoostRecord {
  chainId?: string;
  tokenAddress?: string;
  /** Boost amount in SOL (the unit DexScreener reports). */
  amount?: string;
  /** Boost total in USD (best-effort; null if not derivable). */
  amountUsd?: number;
  url?: string;
}

export interface DexScreenerBoostsOptions {
  fetch?: FetchLike;
  baseUrl?: string;
}

export class DexScreenerBoostsFeed implements MarketDataProvider {
  readonly id = 'dexscreener-boosts';
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;

  constructor(opts: DexScreenerBoostsOptions = {}) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.baseUrl = opts.baseUrl ?? 'https://api.dexscreener.com';
  }

  async discover(options: MarketDiscoveryOptions = {}): Promise<MarketToken[]> {
    // This feed is NOT a discovery source — it returns paid-promotion records,
    // not tradable tokens. Its consumers (sentiment voter) call getBoosts().
    void options;
    return [];
  }

  /** Direct read of the top boosts. Fail-open: [] on transport/parse error. */
  async getBoosts(): Promise<BoostRecord[]> {
    try {
      const res = await this.fetch(`${this.baseUrl}/token-boosts/top/v1`);
      if (!res.ok) return [];
      const body = (await res.json()) as BoostRecord[] | { boosts?: BoostRecord[] };
      const list = Array.isArray(body) ? body : (body.boosts ?? []);
      return list;
    } catch {
      return [];
    }
  }

  /** Direct read of latest ads. Fail-open: []. */
  async getAds(): Promise<BoostRecord[]> {
    try {
      const res = await this.fetch(`${this.baseUrl}/ads/latest/v1`);
      if (!res.ok) return [];
      const body = (await res.json()) as BoostRecord[] | { ads?: BoostRecord[] };
      const list = Array.isArray(body) ? body : (body.ads ?? []);
      return list;
    } catch {
      return [];
    }
  }
}

/** Env-gate helper (mirrors other *_FEED_ENABLED patterns). */
export function dexscreenerBoostsEnabled(): boolean {
  return process.env.DEXSCREENER_BOOSTS_ENABLED === 'true';
}
