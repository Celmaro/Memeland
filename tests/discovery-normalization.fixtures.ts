/**
 * 6.6 — Golden normalization fixtures for the discovery boundary.
 *
 * The CoinGecko→GeckoTerminal migration broke 3 tests because a provider shape
 * changed. These fixtures pin the OUTPUT of `normalizeDexToken` /
 * `normalizeTapeWindow` per chain so a provider-format change is caught at the
 * boundary in CI, not as a deep behavioral regression.
 */
import { normalizeDexToken, normalizeTapeWindow } from '../src/agents/meme-robinhood/robinhood-discovery.js';
import type { MarketToken } from '../src/adapters/market-data-provider.js';
import type { FillTapeWindow } from '../src/adapters/rh-fill-tape.js';
import type { GMGNRawToken } from '../src/adapters/gmgn-adapter.js';
import type { Chain } from '../src/config/chain-config.js';

type PartialTok = Partial<GMGNRawToken>;
type PartialTape = Partial<GMGNRawToken>;

export interface DexGoldenCase {
  name: string;
  chain: Chain;
  input: Partial<MarketToken>;
  source: Parameters<typeof normalizeDexToken>[2];
  expect: PartialTok;
}

export interface TapeGoldenCase {
  name: string;
  chain: Chain;
  input: Partial<FillTapeWindow>;
  expect: PartialTape;
}

/** build a minimum-valid MarketToken from partials. */
function mt(p: Partial<MarketToken>): MarketToken {
  return {
    address: '0x0000000000000000000000000000000000000000',
    chainId: 1,
    symbol: 'TOKEN',
    priceUsd: 0,
    liquidityUsd: 0,
    volume24hUsd: 0,
    ...p,
  } as MarketToken;
}

export const DEX_GOLDEN_CASES: DexGoldenCase[] = [
  {
    name: 'rh dexscreener rich token — real 1h volume wins over /24 estimate',
    chain: 'rh',
    input: mt({ address: '0xrhToken', symbol: 'PEPE', priceUsd: 1.2, liquidityUsd: 50000, volume24hUsd: 24000, volume1hUsd: 3000, mcapUsd: 1_000_000, pairAddress: '0xpair1', dex: 'uniswap-v2' }),
    source: 'dexscreener',
    expect: { chain: 'rh', address: '0xrhToken', symbol: 'PEPE', priceUsd: 1.2, liquidityUsd: 50000, volume24hUsd: 24000, volume1hUsd: 3000, marketCapUsd: 1_000_000, source: 'dexscreener', pairAddress: '0xpair1', dex: 'uniswap-v2' },
  },
  {
    name: 'rh dexpaprika keyless — only 24h, 1h estimate = 24h/24',
    chain: 'rh',
    input: mt({ address: '0xrhDexPa', symbol: 'BONK', priceUsd: 0.5, liquidityUsd: 10000, volume24hUsd: 24000 }), // no volume1hUsd
    source: 'dexpaprika',
    expect: { chain: 'rh', symbol: 'BONK', volume24hUsd: 24000, volume1hUsd: 1000, source: 'dexpaprika' },
  },
  {
    name: 'sol ankr feed-down — sourceUnavailable survives, pool identity retained',
    chain: 'sol',
    input: mt({ address: 'S0Lpubkey123', symbol: 'GECK', priceUsd: 0, liquidityUsd: 0, volume24hUsd: 0, pairAddress: 'S0LPair', dex: 'raydium', sourceUnavailable: true }),
    source: 'ankr',
    expect: { chain: 'sol', address: 'S0Lpubkey123', symbol: 'GECK', sourceUnavailable: true, source: 'ankr', pairAddress: 'S0LPair', dex: 'raydium' },
  },
  {
    name: 'eth gecko — market cap prefers mcap over fdv, pool identity retained',
    chain: 'eth',
    input: mt({ address: '0xEthToken', symbol: 'SHIB', priceUsd: 0.01, mcapUsd: 2_000_000, fdvUsd: 9_000_000, pairAddress: '0xEthPair', dex: 'uniswap-v3' }),
    source: 'gecko',
    expect: { chain: 'eth', address: '0xEthToken', symbol: 'SHIB', marketCapUsd: 2_000_000, source: 'gecko', pairAddress: '0xEthPair', dex: 'uniswap-v3' },
  },
];

export const TAPE_GOLDEN_CASES: TapeGoldenCase[] = [
  {
    name: 'rh tape window — symbol from address prefix, tagged dexscreener',
    chain: 'rh',
    input: { chainId: 1, tokenAddress: '0xTapeAddr', entries: [], truncated: false, failOpen: false } as FillTapeWindow,
    expect: { chain: 'rh', address: '0xTapeAddr', symbol: '0XTAPE', source: 'dexscreener', priceUsd: 0 },
  },
];

/** Convenience runner returning the actual normalized token for a dex case. */
export function runDexCase(c: DexGoldenCase): GMGNRawToken {
  return normalizeDexToken(c.chain, c.input as MarketToken, c.source);
}

/** Convenience runner returning the actual normalized token for a tape case. */
export function runTapeCase(c: TapeGoldenCase): GMGNRawToken {
  return normalizeTapeWindow(c.chain, c.input as FillTapeWindow);
}
