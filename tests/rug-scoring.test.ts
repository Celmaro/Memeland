import { describe, it, expect } from 'vitest';
import { RugScoringService, socialScoreOf } from '../src/services/rug-scoring.js';
import type { GMGNRawToken } from '../src/adapters/gmgn-adapter.js';

function token(over: Partial<GMGNRawToken> = {}): GMGNRawToken {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    chain: 'robinhood',
    address: '0xabc',
    symbol: 'TEST',
    name: 'Test',
    priceUsd: 0.001,
    marketCapUsd: 150000,
    volume24hUsd: 10000,
    volume1hUsd: 5000,
    liquidityUsd: 1000000,
    buys: 100,
    sells: 50,
    swaps: 150,
    holderCount: 5000,
    top10HolderRate: 0.1,
    devTeamHoldRate: 0.05,
    creatorClose: false,
    creatorTokenStatus: null,
    smartDegenCount: 0,
    renownedCount: 0,
    bundlerRate: 0.1,
    ratTraderAmountRate: 0.05,
    rugRatio: 0.1,
    isWashTrading: false,
    isHoneypot: false,
    ctoFlag: false,
    renouncedMint: true,
    renouncedFreeze: true,
    creationTimestamp: nowSec - 60, // 1 min old — inside the early window
    openTimestamp: nowSec - 60,
    priceChange1m: null,
    priceChange5m: null,
    priceChange1h: null,
    visitingCount: 100,
    squareMentions: 20,
    twitterRenameCount: 0,
    twitterDelPostCount: 0,
    twitterCreateTokenCount: 0,
    buyTax: null,
    sellTax: null,
    dexscrBoostFee: 0,
    dexscrAd: 0,
    totalFeeNative: null,
    exchange: null,
    launchpadPlatform: null,
    launchpadStatus: null,
    progress: null,
    source: 'gmgn',
    ...over,
  };
}

describe('RugScoringService', () => {
  it('healthy fresh token passes early-window with no penalties', () => {
    const r = new RugScoringService().assess(token());
    expect(r.freshToken).toBe(true);
    expect(r.score).toBe(100);
    expect(r.penalties).toHaveLength(0);
  });

  it('thin liquidity + few holders + no social proof on a fresh token → heavy penalties', () => {
    const r = new RugScoringService().assess(
      token({ liquidityUsd: 5000, holderCount: 40, visitingCount: 0, squareMentions: 0 })
    );
    expect(r.freshToken).toBe(true);
    expect(r.penalties.length).toBe(3);
    expect(r.score).toBe(25);
  });

  it('older surviving token is not judged on the early window (survivor bias)', () => {
    const old = new RugScoringService().assess(
      token({ creationTimestamp: Math.floor(Date.now() / 1000) - 3600 * 3, liquidityUsd: 1000, holderCount: 10 })
    );
    expect(old.freshToken).toBe(false);
    expect(old.score).toBe(100);
    expect(old.penalties).toHaveLength(0);
  });

  it('unknown creation time is treated as non-fresh (fail-open)', () => {
    const unknown = new RugScoringService().assess(token({ creationTimestamp: null }));
    expect(unknown.freshToken).toBe(false);
    expect(unknown.score).toBe(100);
  });

  it('socialScoreOf blends visits and mentions', () => {
    const t = token({ visitingCount: 50, squareMentions: 3 });
    expect(socialScoreOf(t)).toBe(80);
  });
});
