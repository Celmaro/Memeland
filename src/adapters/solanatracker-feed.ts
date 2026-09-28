/**
 * SolanaTracker enricher (provider-architecture v2: `solanatracker`).
 *
 * Solana-only indexer data behind the shared ProviderGovernor. Per the research
 * doc (docs/research/solanatracker-pumpdev-providers.md) this is an ENRICHER:
 * indexer-derived REST data hydrates ALREADY-KNOWN token addresses — it does NOT
 * introduce raw addresses at the canonical real-time level (that is Helius /
 * Ankr / PumpDev-launch). So under DISCOVERY_INTRODUCERS scoping it recall/
 * hydrates only and never promotes.
 *
 * Free tier: 10,000 req/mo @ 3 req/sec (REST only; Datastream WS is a separate
 * paid product). We self-pace to a conservative daily cap + 3 rpm + 60s cache
 * and hard-freeze on 402/429, so the free quota is never burned.
 *
 * Fail-soft by design: any transport/parse error yields `[]` (discover) or
 * `null` (tokenDetail) — an outage never blocks or biases screening.
 */

import type { MarketDataProvider, MarketToken, MarketDiscoveryOptions } from './market-data-provider.js';
import { chainIdFor } from './market-data-provider.js';
import { ProviderGovernor, globalProviderGovernor } from '../services/provider-governor.js';

export const SOLANATRACKER_BASE = 'https://data.solanatracker.io';
/** Solana chain id used by the market-data layer. */
export const SOLANA_CHAIN_ID = 101;
/** Conservative free-tier guardrails (10k/mo, 3 rps). */
export const SOLANATRACKER_DAILY_CAP = 300;
export const SOLANATRACKER_RPM = 3;
/** Cache so a burst never re-fetches the same address inside a minute. */
export const SOLANATRACKER_TTL_MS = 60_000;

export interface SolanaTrackerOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  governor?: ProviderGovernor;
  dailyCap?: number;
  rpm?: number;
  ttlMs?: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Normalize a single raw row into a MarketToken (tolerant of source shapes). */
function toMarketToken(row: Record<string, unknown>): MarketToken | null {
  const address = str(row.tokenAddress ?? row.token_ca ?? row.address ?? row.mint);
  if (!address) return null;
  const priceUsd = num(row.priceUsd ?? row.price);
  const liquidityUsd = num(row.liquidityUsd ?? row.liquidity ?? row.poolLiquidityUsd);
  const volume24hUsd = num(row.volumeUsd ?? row.volume ?? row.volume24hUsd);
  return {
    address,
    chainId: SOLANA_CHAIN_ID,
    symbol: str(row.symbol).slice(0, 32),
    name: str(row.name),
    priceUsd,
    liquidityUsd,
    volume24hUsd,
    fdvUsd: num(row.fdvUsd ?? row.fdv),
    mcapUsd: num(row.marketCapUsd ?? row.marketCap),
    change24hPct: num(row.priceChange24h ?? row.priceChange1d),
    dex: 'solanatracker',
    // Indexer-factual (real prices/volumes), NOT a hint.
    freshLane: false,
  };
}

export class SolanaTrackerFeed implements MarketDataProvider {
  readonly id = 'solanatracker';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly governor: ProviderGovernor;
  private readonly cfg;

  constructor(opts: SolanaTrackerOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? SOLANATRACKER_BASE).replace(/\/$/, '');
    this.fetch = opts.fetch ?? (globalThis.fetch as typeof fetch);
    this.governor = opts.governor ?? globalProviderGovernor;
    this.cfg = {
      id: 'solanatracker',
      dailyCap: opts.dailyCap ?? SOLANATRACKER_DAILY_CAP,
      rpm: opts.rpm ?? SOLANATRACKER_RPM,
      assumedCostPerCall: 1,
      ttlMs: opts.ttlMs ?? SOLANATRACKER_TTL_MS,
    };
  }

  /** GET an authenticated SolanaTracker endpoint through the governor. */
  private async get<T>(path: string, cacheKey: string, params: Record<string, string | number> = {}): Promise<T | null> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    const sep = qs.toString() ? `?${qs.toString()}` : '';
    const url = `${this.baseUrl}${path}${sep}`;
    const attempt = await this.governor.run<T>(this.id, this.cfg, cacheKey, async () => {
      const res = await this.fetch(url, {
        headers: { accept: 'application/json', 'x-api-key': this.apiKey },
      });
      const data = (await res.json()) as T;
      return { status: res.status, data, creditsUsed: 1 };
    });
    if (!attempt.ok) return null;
    return attempt.data ?? null;
  }

  /**
   * Solana trending/latest-tokens discovery. Tolerant of a top-level array,
   * `{ tokens: [...] }`, or `{ data: [...] }`. Sol-only; an anything-else
   * result is filtered out (Faill-soft []).
   */
  async discover(options: MarketDiscoveryOptions = {}): Promise<MarketToken[]> {
    const chainIds = options.chainIds ?? [];
    if (chainIds.length > 0 && !chainIds.includes(SOLANA_CHAIN_ID)) return [];
    const raw = await this.get<unknown>('/tokens/latest', 'latest:solana', { network: 'solana' });
    const rows = asRowArray(raw);
    const out: MarketToken[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const t = toMarketToken(row);
      if (!t) continue;
      const key = t.address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }

  /** Granular short-window volume/flow for a known Sol address (best-effort). */
  async tokenDetail(
    chain: string,
    address: string,
  ): Promise<{ volume1hUsd?: number; buyUsd1h?: number; sellUsd1h?: number } | null> {
    if (chainIdFor(chain) !== SOLANA_CHAIN_ID) return null;
    const data = await this.get<Record<string, unknown>>(`/price`, `price:${address.toLowerCase()}`, { token: address });
    if (!data) return null;
    const volume1hUsd = num(data.volume1h ?? data.volume);
    const buyUsd1h = num(data.buyVolume1h ?? data.buy);
    const sellUsd1h = num(data.sellVolume1h ?? data.sell);
    if (volume1hUsd === 0 && buyUsd1h === 0 && sellUsd1h === 0) return null;
    return { volume1hUsd, buyUsd1h, sellUsd1h };
  }
}

/** Extract an array of rows from the many shapes SolanaTracker can return. */
function asRowArray(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const key of ['tokens', 'data', 'results']) {
      const v = o[key];
      if (Array.isArray(v)) return v.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
    }
    // A bare token object ('/price' style) counts as one row.
    if (typeof o.tokenAddress === 'string' || typeof o.address === 'string') return [o];
  }
  return [];
}