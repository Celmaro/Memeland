/**
 * Q06 - Shared market-data provider interface (SRC-025/222/010/023).
 * A small interface so GMGN is one of several interchangeable discovery paths
 * (DexScreener, dexpaprika, ...). Implementations are keyless
 * REST clients behind a TTL cache and must normalize to a common shape.
 */

export interface MarketToken {
  address: string;
  chainId: number;
  symbol: string;
  name?: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  fdvUsd?: number;
  mcapUsd?: number;
  change24hPct?: number;
  pairAddress?: string;
  dex?: string;
  /**
   * I1-4: true when the source feed FAILED to supply market data (transport /
   * rate-limit), as opposed to a genuine zero-volume observation. A feed that
   * returns nothing must be distinguishable from a token that trades nothing —
   * otherwise a provider outage looks like "no candidates have volume".
   */
  sourceUnavailable?: boolean;
  /**
   * Fresh-pair lane (see GMGNRawToken.freshLane). Market providers can mark
   * raw new-pair discoveries so the prefilter uses the fresh floor.
   */
  freshLane?: boolean;
}

export type MarketSort = 'volume24hUsd' | 'liquidityUsd' | 'fdvUsd';

export interface MarketDiscoveryOptions {
  /** Restrict to these chain ids (default: all supported). */
  chainIds?: number[];
  /** Only tokens with at least this much pooled liquidity (default 0). */
  minLiquidityUsd?: number;
  sort?: MarketSort;
  limit?: number;
}

export interface MarketDataProvider {
  readonly id: string;
  /** Discover and normalize tokens across the supported chains. */
  discover(options?: MarketDiscoveryOptions): Promise<MarketToken[]>;
}

/** Canonical chain-name → chain-id map used by normalized providers. */
export const CHAIN_NAME_TO_ID: Record<string, number> = {
  robinhood: 4663,
  rh: 4663,
  bsc: 56,
  binance: 56,
  base: 8453,
  solana: 101,
  sol: 101,
  eth: 1,
  ethereum: 1,
};

export function chainIdFor(name: string | null | undefined): number | undefined {
  if (!name) return undefined;
  return CHAIN_NAME_TO_ID[String(name).toLowerCase().trim()];
}
