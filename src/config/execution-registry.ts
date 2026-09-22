/**
 * Execution chain registry — the single source of truth for which chains are
 * executable and how LI.FI/Jumper addresses each one.
 *
 * LI.FI is the only execution layer. GMGN stays the screener / data / audit
 * source. Every chain the bot may fill a trade on must resolve here; unknown
 * chains fail closed (never silently default to a chain id).
 */

export type ExecutionChainKey = 'eth' | 'bsc' | 'base' | 'robinhood' | 'sol';

/** A known funding token used to quote the "from" leg of an execution. */
export interface FundingToken {
  symbol: string;
  /** On-chain address/mint. EVM uses the zero address for the native coin. */
  address: string;
  /** Decimals for fromAmount conversion. */
  decimals: number;
  /** Assumed USD price (1 for stablecoins). Native coins fail closed here. */
  priceUsd: number;
}

export interface ExecutionChainConfig {
  key: ExecutionChainKey;
  /** LI.FI chain id — EVM ids plus Solana's encoded id `1151111081099710`. */
  lifiChainId: number;
  /** Native gas coin symbol (ETH / BNB / SOL). */
  nativeCoin: string;
  /** Default funding token symbol (USDC where available, USDG on Robinhood). */
  fundingTokenSymbol: string;
  /** Explorer transaction URL template with a `{txHash}` placeholder. */
  explorerTxTemplate: string;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const EXECUTION_CHAIN_REGISTRY: Record<ExecutionChainKey, ExecutionChainConfig> = {
  eth: {
    key: 'eth',
    lifiChainId: 1,
    nativeCoin: 'ETH',
    fundingTokenSymbol: 'USDC',
    explorerTxTemplate: 'https://etherscan.io/tx/{txHash}',
  },
  bsc: {
    key: 'bsc',
    lifiChainId: 56,
    nativeCoin: 'BNB',
    fundingTokenSymbol: 'USDC',
    explorerTxTemplate: 'https://bscscan.com/tx/{txHash}',
  },
  base: {
    key: 'base',
    lifiChainId: 8453,
    nativeCoin: 'ETH',
    fundingTokenSymbol: 'USDC',
    explorerTxTemplate: 'https://basescan.org/tx/{txHash}',
  },
  robinhood: {
    key: 'robinhood',
    lifiChainId: 4663,
    nativeCoin: 'ETH',
    fundingTokenSymbol: 'USDG',
    explorerTxTemplate: 'https://robinhoodchain.blockscout.com/tx/{txHash}',
  },
  sol: {
    key: 'sol',
    lifiChainId: 1151111081099710,
    nativeCoin: 'SOL',
    fundingTokenSymbol: 'USDC',
    explorerTxTemplate: 'https://solscan.io/tx/{txHash}',
  },
};

export const EXECUTION_CHAIN_KEYS = Object.keys(EXECUTION_CHAIN_REGISTRY) as ExecutionChainKey[];

/**
 * Funding token addresses (and decimals / USD price) per chain. Stablecoins
 * fund buys 1:1 with the USD notional; native coins are intentionally excluded
 * from funding (their USD price is not statically knowable).
 */
export const FUNDING_TOKENS: Record<ExecutionChainKey, Record<string, FundingToken>> = {
  eth: {
    USDC: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, priceUsd: 1 },
    ETH: { symbol: 'ETH', address: ZERO_ADDRESS, decimals: 18, priceUsd: 0 },
  },
  bsc: {
    USDC: { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, priceUsd: 1 },
    BNB: { symbol: 'BNB', address: ZERO_ADDRESS, decimals: 18, priceUsd: 0 },
  },
  base: {
    USDC: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, priceUsd: 1 },
    ETH: { symbol: 'ETH', address: ZERO_ADDRESS, decimals: 18, priceUsd: 0 },
  },
  robinhood: {
    // No native USDC on Robinhood Chain via LI.FI today — USDG is the stablecoin.
    USDG: { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6, priceUsd: 1 },
    WETH: { symbol: 'WETH', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', decimals: 18, priceUsd: 0 },
    ETH: { symbol: 'ETH', address: ZERO_ADDRESS, decimals: 18, priceUsd: 0 },
  },
  sol: {
    USDC: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, priceUsd: 1 },
    SOL: { symbol: 'SOL', address: '11111111111111111111111111111111', decimals: 9, priceUsd: 0 },
  },
};

/** Canonical-key alias map (mirrors approval-execution.normalizeChain). */
const CHAIN_ALIASES: Record<string, ExecutionChainKey> = {
  robinhood: 'robinhood',
  hood: 'robinhood',
  solana: 'sol',
  sol: 'sol',
  'bnb chain': 'bsc',
  bsc: 'bsc',
  binance: 'bsc',
  base: 'base',
  ethereum: 'eth',
  eth: 'eth',
};

/** Normalize any payload/approval chain label to a canonical key, or null. */
export function normalizeExecutionChainKey(value: string): ExecutionChainKey | null {
  const key = String(value || '').trim().toLowerCase();
  return CHAIN_ALIASES[key] ?? null;
}

/** Fail-closed chain resolution. Throws on unknown chains. */
export function resolveExecutionChain(value: string): ExecutionChainConfig {
  const key = normalizeExecutionChainKey(value);
  const cfg = key ? EXECUTION_CHAIN_REGISTRY[key] : undefined;
  if (!cfg) {
    throw new Error(`unknown execution chain '${value}' — fail-closed (no chain id default)`);
  }
  return cfg;
}

/**
 * The set of executable chains derived from the registry plus `MULTICHAIN_CHAINS`.
 * Unknown entries are ignored; an empty result means NO chain can execute.
 */
export function executableChainsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<ExecutionChainKey> {
  const raw = (env.MULTICHAIN_CHAINS || '').trim();
  const chains = new Set<ExecutionChainKey>();
  if (!raw) return chains;
  for (const part of raw.split(',')) {
    const key = normalizeExecutionChainKey(part);
    if (key) chains.add(key);
  }
  return chains;
}

/** Explorer URL for a confirmed transaction on a given chain. */
export function explorerUrlForChain(key: ExecutionChainKey, txHash: string): string {
  const cfg = EXECUTION_CHAIN_REGISTRY[key];
  return cfg.explorerTxTemplate.replace('{txHash}', txHash);
}

/**
 * Resolve the configured funding token for a chain into concrete LI.FI input
 * metadata. Fails closed (throws) when the token is unknown or not a stablecoin
 * funding source (native coin USD price is not statically known).
 */
export function resolveFundingToken(chainKey: ExecutionChainKey, fundingTokenSymbol?: string): FundingToken {
  const symbol = (fundingTokenSymbol || EXECUTION_CHAIN_REGISTRY[chainKey].fundingTokenSymbol).toUpperCase();
  const token = FUNDING_TOKENS[chainKey]?.[symbol];
  if (!token) {
    throw new Error(`no funding token '${symbol}' on chain '${chainKey}' — fail-closed`);
  }
  if (token.priceUsd <= 0) {
    throw new Error(`funding token '${symbol}' on '${chainKey}' is not a stablecoin and cannot be priced statically — fail-closed`);
  }
  return token;
}
