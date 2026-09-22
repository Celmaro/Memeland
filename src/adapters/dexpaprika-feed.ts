/**
 * PR 7 — DEXPaprika keyless multi-chain feed + drain-detection (Standalone #2)
 * + CoinCap/DEXPaprika reserve-streaming Adapt.
 * Keyless REST discovery normalized to the shared MarketToken shape, plus a
 * declarative drain detector for SSE reserve-streaming events (a pair whose
 * pooled liquidity drops sharply is flagged — a common rug precursor).
 * Deliberately NOT merged with codex-feed.ts (different auth/schema/rate limits).
 */

import {
  chainIdFor,
  type MarketDataProvider,
  type MarketDiscoveryOptions,
  type MarketToken,
} from './market-data-provider.js';
import { TtlCache } from '../cache/ttl-cache.js';

export const DEXPAPRIKA_DEFAULT_BASE = 'https://api.dexpaprika.com';

type FetchLike = (url: string) => Promise<Pick<Response, 'ok' | 'json'>>;

interface RawPair {
  chain?: string;
  pair?: {
    address?: string;
    baseToken?: { address?: string; symbol?: string; name?: string };
  };
  liquidityUsd?: string;
  volumeUsd24?: string;
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
    (opts.supportedChains ?? ['robinhood', 'bsc', 'base', 'solana']).map((c) => c.toLowerCase())
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
    const tokens = await this.fetchPairs();
    this.cache.set(key, tokens);
    return tokens;
  }

  private async fetchPairs(): Promise<MarketToken[]> {
    const res = await this.fetch(this.baseUrl + '/pairs');
    if (!res.ok) throw new Error('dexpaprika pairs fetch failed');
    const body = (await res.json()) as { data?: RawPair[] };
    const pairs = Array.isArray(body?.data) ? body.data : [];
    const tokens: MarketToken[] = [];
    for (const p of pairs) {
    const t = this.normalizePair(p);
    if (t) tokens.push(t);
    }
    return tokens;
  }

  private normalizePair(p: RawPair): MarketToken | undefined {
    const chainId = chainIdFor(p.chain);
    if (chainId === undefined || !this.supportedChains.has(String(p.chain).toLowerCase())) return undefined;
    const bt = p.pair?.baseToken;
    if (!bt?.address || !bt.symbol) return undefined;
    return {
    address: bt.address,
    chainId,
    symbol: bt.symbol,
    ...(bt.name ? { name: bt.name } : {}),
    priceUsd: 0,
    liquidityUsd: this.num(p.liquidityUsd),
    volume24hUsd: this.num(p.volumeUsd24),
    ...(p.pair?.address ? { pairAddress: p.pair.address } : {}),
    };
  }

  private num(raw: string | undefined): number {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
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
