/**
 * PR 7 — DEXPaprika keyless multi-chain feed (Standalone #2)
 * + CoinCap/DEXPaprika reserve-streaming Adapt.
 *
 * 2026-09-23 (Zeabur audit fix): DEXPaprika restructured its API on 2026-06-30 —
 * the old `/pairs`, `/pools`, `/tokens/top` endpoints now return 410/404. The
 * replacement is the unified search family:
 *
 *   GET /networks/{network}/pools/search
 *       ?order_by=volume_usd_24h&sort=desc&limit=N[&liquidity_usd_min=...]
 *
 * Response: `{ results: PoolRow[], has_next_page, next_cursor, query }` where
 * PoolRow = { id, chain, volume_usd_24h, liquidity_usd, price_usd,
 *             transactions_24h, tokens: [{ id (=contract), chain, ... }] }.
 *
 * This adapter was calling `${baseUrl}/pairs` — dead since the restructure —
 * which is why the live logs showed `dexpaprika pairs fetch failed`. Rewritten
 * for the search API. Keyless, no rate limits, covers robinhood/solana/bsc/
 * base/ethereum — the real GMGN-decoupling lever (research A16).
 */

import {
  chainIdFor,
  type MarketDataProvider,
  type MarketDiscoveryOptions,
  type MarketToken,
} from './market-data-provider.js';
import { TtlCache } from '../cache/ttl-cache.js';

export const DEXPAPRIKA_DEFAULT_BASE = 'https://api.dexpaprika.com';

type FetchLike = (url: string) => Promise<Pick<Response, 'ok' | 'json' | 'status'>>;

/** New unified-search pool row (2026-06-30 API). */
interface RawPoolRow {
  id?: string; // pool address
  chain?: string;
  volume_usd_24h?: number | string;
  liquidity_usd?: number | string;
  price_usd?: number | string;
  transactions_24h?: number;
  price_change_percentage_1h?: number | string;
  price_change_percentage_5m?: number | string;
  price_change_percentage_6h?: number | string;
  price_change_percentage_24h?: number | string;
  tokens?: Array<{ id?: string; chain?: string; symbol?: string; name?: string }>;
}

/** Per-token detail row (item 4): carries granular 1h/15m/5m volume. */
interface RawTokenDetail {
  summary?: {
    price_usd?: number | string;
    liquidity_usd?: number | string;
    '1h'?: { volume_usd?: number | string };
    '15m'?: { volume_usd?: number | string };
    '5m'?: { volume_usd?: number | string };
    '24h'?: { volume_usd?: number | string };
  };
}

export interface DexpaprikaFeedOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  /** TTL for the in-memory discovery cache in ms. Default 60s. */
  ttlMs?: number;
  supportedChains?: string[];
}

export interface DrainInput {
  pairAddress: string;
  chain: string;
  prevLiquidityUsd: number;
  currLiquidityUsd: number;
}

export interface DexpaprikaDrainEvent {
  pairAddress: string;
  chain: string;
  drained: boolean;
  dropPct: number;
}

/** Drain threshold: liquidity dropping >= 50% in an SSE tick is flagged. */
const DRAIN_THRESHOLD_PCT = 50;

export class DexpaprikaFeed implements MarketDataProvider {
  readonly id = 'dexpaprika';
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly supportedChains: Set<string>;
  private readonly cache: TtlCache<MarketToken[]>;

  constructor(opts: DexpaprikaFeedOptions = {}) {
    const f = opts.fetch ?? ((globalThis as { fetch?: FetchLike }).fetch as FetchLike);
    this.fetch = f;
    this.baseUrl = opts.baseUrl ?? DEXPAPRIKA_DEFAULT_BASE;
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.cache = new TtlCache<MarketToken[]>({ ttlMs: this.ttlMs });
    this.supportedChains = new Set(
      (opts.supportedChains ?? ['robinhood', 'bsc', 'base', 'solana', 'ethereum']).map((c) => c.toLowerCase())
    );
  }

  async discover(options: MarketDiscoveryOptions = {}): Promise<MarketToken[]> {
    const base = await this.baseTokens();
    return this.applyOptions(base, options);
  }

  /** Declarative drain detection over an SSE reserve tick. */
  public drainEvent(input: DrainInput): DexpaprikaDrainEvent {
    const prev = input.prevLiquidityUsd;
    const curr = input.currLiquidityUsd;
    let dropPct = 0;
    if (prev > 0) {
      dropPct = Math.max(0, Math.min(100, ((prev - curr) / prev) * 100));
    }
    return {
      pairAddress: input.pairAddress,
      chain: input.chain,
      drained: dropPct >= DRAIN_THRESHOLD_PCT,
      dropPct: Math.round(dropPct),
    };
  }

  private async baseTokens(): Promise<MarketToken[]> {
    const key = 'base';
    const cached = this.cache.get(key);
    if (cached) return cached;
    const tokens = await this.fetchSearchAll();
    this.cache.set(key, tokens);
    return tokens;
  }

  /**
   * Fetch the top pools across every supported chain via the unified
   * `/pools/search` endpoint (global form), sorted by 24h volume. This keeps
   * one call per provider pass — no per-chain fan-out, so DEXPaprika's
   * keyless tier is never stressed (no documented rate limits).
   */
  private async fetchSearchAll(): Promise<MarketToken[]> {
    const chains = [...this.supportedChains].join(',');
    const url =
      `${this.baseUrl}/pools/search` +
      `?order_by=volume_usd_24h&sort=desc&limit=100` +
      (chains ? `&networks=${encodeURIComponent(chains)}` : '');
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`dexpaprika search failed (HTTP ${res.status})`);
    const body = (await res.json()) as { results?: RawPoolRow[] };
    const rows = Array.isArray(body?.results) ? body.results : [];
    const tokens: MarketToken[] = [];
    for (const row of rows) {
      const t = this.normalizeRow(row);
      if (t) tokens.push(t);
    }
    return tokens;
  }

  private normalizeRow(row: RawPoolRow): MarketToken | undefined {
    const chain = String(row.chain || '').toLowerCase();
    const chainId = chainIdFor(chain);
    if (chainId === undefined || !this.supportedChains.has(chain)) return undefined;
    // Base token = the pool's first token entry (contract address in `id`).
    // DEXPaprika doesn't return symbols in the search rows — the address is
    // the join key; enrichment (GMGN) fills symbol/price later.
    const baseToken = Array.isArray(row.tokens) ? row.tokens[0] : undefined;
    const address = baseToken?.id;
    if (!address) return undefined;
    return {
      address,
      chainId,
      symbol: baseToken?.symbol || address.slice(0, 6).toUpperCase(),
      ...(baseToken?.name ? { name: baseToken.name } : {}),
      priceUsd: this.num(row.price_usd),
      liquidityUsd: this.num(row.liquidity_usd),
      volume24hUsd: this.num(row.volume_usd_24h),
      // Item 4: DEXPaprika search rows carry real 1h/5m/6h/24h price change for
      // free — wire them so the momentum/technical path isn't GMGN-only.
      change1hPct: this.optNum(row.price_change_percentage_1h),
      change5mPct: this.optNum(row.price_change_percentage_5m),
      change24hPct: this.optNum(row.price_change_percentage_24h),
      ...(row.id ? { pairAddress: row.id } : {}),
    };
  }

  /**
   * Item 4: fetch a token's granular volume detail (1h/15m/5m) — the search
   * rows only carry 24h volume, so prefilter survivors on dexpaprika can get
   * precise short-window volume via /networks/{network}/tokens/{address}.
   * Fail-soft: null on transport/parse error (caller falls back to 24h/24).
   */
  public async tokenDetail(
    chain: string,
    address: string,
  ): Promise<{ volume1hUsd?: number; volume15mUsd?: number; volume5mUsd?: number } | null> {
    try {
      // Chain-name aliasing: the agent passes chain keys ('sol','eth') but
      // DEXPaprika networks are named ('solana','ethereum'). Resolve to the
      // canonical network id the provider uses internally.
      const network = this.chainToNetwork(chain);
      if (!network) return null;
      const url = `${this.baseUrl}/networks/${encodeURIComponent(network)}/tokens/${encodeURIComponent(address)}`;
      const res = await this.fetch(url);
      if (!res.ok) return null;
      const body = (await res.json()) as RawTokenDetail;
      const s = body?.summary;
      if (!s) return null;
      const vol = (v: unknown): number | undefined => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      return {
        volume1hUsd: vol(s['1h']?.volume_usd),
        volume15mUsd: vol(s['15m']?.volume_usd),
        volume5mUsd: vol(s['5m']?.volume_usd),
      };
    } catch {
      return null;
    }
  }

  /** Map bot chain keys / canonical names onto DEXPaprika network ids. */
  private chainToNetwork(chain: string): string | null {
    const c = chain.toLowerCase();
    if (c === 'sol' || c === 'solana') return 'solana';
    if (c === 'eth' || c === 'ethereum') return 'ethereum';
    if (c === 'bsc' || c === 'binance') return 'bsc';
    if (c === 'base') return 'base';
    if (c === 'robinhood' || c === 'rh') return 'robinhood';
    return null;
  }

  private num(raw: string | number | undefined): number {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  /** Optional number — undefined for missing/non-numeric, so callers can tell
   *  "not reported" from a genuine 0. */
  private optNum(raw: string | number | undefined): number | undefined {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }

  private applyOptions(base: MarketToken[], options: MarketDiscoveryOptions): MarketToken[] {
    let out = base;
    if (options.chainIds && options.chainIds.length > 0) {
      out = out.filter((t) => options.chainIds!.includes(t.chainId));
    }
    if (options.minLiquidityUsd !== undefined) {
      out = out.filter((t) => t.liquidityUsd >= options.minLiquidityUsd!);
    }
    if (options.sort) {
      out = [...out].sort((a, b) => (b[options.sort!] ?? 0) - (a[options.sort!] ?? 0));
    }
    if (options.limit !== undefined && options.limit > 0) out = out.slice(0, options.limit);
    return out;
  }
}