/**
 * Kernel V — Robinhood discovery normalization.
 * Extracted from robinhood-screening-agent.ts: the pure candidate-normalization
 * helpers (tape window → GMGNRawToken, MarketToken → GMGNRawToken, chain-aware
 * discovery filters). No instance state — the agent imports these instead of
 * holding them inline, so the discovery pass is unit-testable in isolation.
 */

import type { GMGNRawToken, Chain } from '../../adapters/gmgn-adapter.js';
import type { FillTapeWindow } from '../../adapters/rh-fill-tape.js';
import type { MarketToken } from '../../adapters/market-data-provider.js';

/**
 * Chain-aware discovery filter set. 'renounced' is Solana-only; EVM chains
 * drop it (GMGN doesn't fill that field there).
 */
export function discoveryFiltersForChain(chain: Chain): string[] {
  const evm = chain !== 'sol';
  return evm
    ? ['not_honeypot', 'verified', 'is_out_market']
    : ['not_honeypot', 'verified', 'renounced', 'is_out_market'];
}

/** Normalize a Q04 fill-tape window into a GMGNRawToken (source 'dexscreener'). */
export function normalizeTapeWindow(chain: Chain, window: FillTapeWindow): GMGNRawToken {
  const address = window.tokenAddress || '';
  const symbol = (address.slice(0, 6) || 'TAPE').toUpperCase();
  return {
    chain,
    address,
    symbol,
    name: `Tape ${symbol}`,
    priceUsd: 0, marketCapUsd: 0, volume24hUsd: 0, volume1hUsd: 0, liquidityUsd: 0,
    buys: 0, sells: 0, swaps: 0, holderCount: 0,
    top10HolderRate: null, devTeamHoldRate: null, creatorClose: false, creatorTokenStatus: null,
    smartDegenCount: 0, renownedCount: 0, bundlerRate: null, ratTraderAmountRate: null,
    rugRatio: null, isWashTrading: false, isHoneypot: null, ctoFlag: false,
    renouncedMint: false, renouncedFreeze: false, creationTimestamp: null, openTimestamp: null,
    priceChange1m: null, priceChange5m: null, priceChange1h: null,
    visitingCount: 0, squareMentions: 0,
    twitterRenameCount: 0, twitterDelPostCount: 0, twitterCreateTokenCount: 0,
    buyTax: null, sellTax: null, dexscrBoostFee: 0, dexscrAd: 0, totalFeeNative: null,
    exchange: null, launchpadPlatform: null, launchpadStatus: null, progress: null,
    source: 'dexscreener',
  };
}

/** Normalize a keyless-feed MarketToken into a GMGNRawToken tagged with its source. */
export function normalizeDexToken(
  chain: Chain,
  t: MarketToken,
  source: 'gmgn' | 'dexscreener' | 'codex' | 'dexpaprika' = 'dexscreener',
): GMGNRawToken {
  const symbol = t.symbol || 'TOKEN';
  return {
    chain,
    address: t.address,
    symbol,
    name: t.name || symbol,
    priceUsd: t.priceUsd || 0,
    marketCapUsd: t.mcapUsd ?? t.fdvUsd ?? 0,
    volume24hUsd: t.volume24hUsd || 0,
    // Keyless feeds (dexscreener/dexpaprika/codex) only report 24h volume —
    // no volume_1h field. Without this fallback the prefilter floor
    // (minVolume1hUsd) would reject every candidate as volume 1h $0.0k,
    // making the boosters dead code (observed live on Zeabur, 2026-09-23).
    // Same semantics as gmgn-adapter Fix #2: 1h ≈ 24h/24 when only 24h exists.
    volume1hUsd: t.volume24hUsd > 0 ? t.volume24hUsd / 24 : 0,
    liquidityUsd: t.liquidityUsd || 0,
    buys: 0, sells: 0, swaps: 0, holderCount: 0,
    top10HolderRate: null, devTeamHoldRate: null, creatorClose: false, creatorTokenStatus: null,
    smartDegenCount: 0, renownedCount: 0, bundlerRate: null, ratTraderAmountRate: null,
    rugRatio: null, isWashTrading: false, isHoneypot: null, ctoFlag: false,
    renouncedMint: false, renouncedFreeze: false, creationTimestamp: null, openTimestamp: null,
    priceChange1m: null, priceChange5m: null, priceChange1h: null,
    visitingCount: 0, squareMentions: 0,
    twitterRenameCount: 0, twitterDelPostCount: 0, twitterCreateTokenCount: 0,
    buyTax: null, sellTax: null, dexscrBoostFee: 0, dexscrAd: 0, totalFeeNative: null,
    exchange: null, launchpadPlatform: null, launchpadStatus: null, progress: null,
    source,
  };
}