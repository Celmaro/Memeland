import { describe, it, expect } from 'vitest';
import { GMGNAdapter, gmgnTokenToMarketToken, type GMGNRawToken } from '../src/adapters/gmgn-adapter.js';

function token(overrides: Partial<GMGNRawToken> = {}): GMGNRawToken {
  return {
    chain: 'sol',
    address: '0xabc',
    symbol: 'TEST',
    name: 'Test Token',
    priceUsd: 0.001,
    marketCapUsd: 100000,
    volume24hUsd: 200000,
    volume1hUsd: 50000,
    liquidityUsd: 30000,
    buys: 800,
    sells: 200,
    swaps: 1000,
    holderCount: 500,
    top10HolderRate: 0.1,
    devTeamHoldRate: 0.02,
    creatorClose: false,
    creatorTokenStatus: null,
    smartDegenCount: 5,
    renownedCount: 1,
    bundlerRate: 0.1,
    ratTraderAmountRate: null,
    rugRatio: 0.01,
    isWashTrading: false,
    isHoneypot: null,
    ctoFlag: true,
    renouncedMint: true,
    renouncedFreeze: false,
    creationTimestamp: 1786000000,
    openTimestamp: 1786000000,
    priceChange1m: 1,
    priceChange5m: 2,
    priceChange1h: 55,
    visitingCount: 300,
    squareMentions: 0,
    twitterRenameCount: 0,
    twitterDelPostCount: 0,
    twitterCreateTokenCount: 1,
    buyTax: null,
    ...overrides,
  };
}

describe('gmgnTokenToMarketToken', () => {
  it('maps a GMGN token onto the shared MarketToken discovery shape', () => {
    const t = gmgnTokenToMarketToken(token());
    expect(t).toEqual({
      address: '0xabc',
      chainId: 101,
      symbol: 'TEST',
      name: 'Test Token',
      priceUsd: 0.001,
      liquidityUsd: 30000,
      volume24hUsd: 200000,
      mcapUsd: 100000,
    });
  });

  it('resolves each discovery chain id from the GMGN chain name', () => {
    expect(gmgnTokenToMarketToken(token({ chain: 'robinhood' }))?.chainId).toBe(4663);
    expect(gmgnTokenToMarketToken(token({ chain: 'bsc' }))?.chainId).toBe(56);
    expect(gmgnTokenToMarketToken(token({ chain: 'base' }))?.chainId).toBe(8453);
    expect(gmgnTokenToMarketToken(token({ chain: 'sol' }))?.chainId).toBe(101);
  });

  it('drops chains outside the discovery map (e.g. eth)', () => {
    expect(gmgnTokenToMarketToken(token({ chain: 'eth' }))).toBeUndefined();
  });

  it('omits mcapUsd when marketCapUsd is zero/unknown', () => {
    const t = gmgnTokenToMarketToken(token({ marketCapUsd: 0 }));
    expect(t?.mcapUsd).toBeUndefined();
  });
});

describe('GMGNAdapter.toMarketTokens', () => {
  it('maps a batch and filters unsupported chains', () => {
    const adapter = new GMGNAdapter();
    const mapped = adapter.toMarketTokens([token({ chain: 'sol' }), token({ chain: 'eth' }), token({ chain: 'base' })]);
    expect(mapped.map((t) => t.chainId)).toEqual([101, 8453]);
  });
});
