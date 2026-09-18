import { describe, it, expect } from 'vitest';
import { BotDetectionService, severityFor, BotRiskWindow } from '../src/services/bot-detection.js';
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
    liquidityUsd: 50000,
    buys: 100,
    sells: 50,
    swaps: 150,
    holderCount: 500,
    top10HolderRate: null,
    devTeamHoldRate: null,
    creatorClose: false,
    creatorTokenStatus: null,
    smartDegenCount: 0,
    renownedCount: 0,
    bundlerRate: null,
    ratTraderAmountRate: null,
    rugRatio: null,
    isWashTrading: false,
    isHoneypot: false,
    ctoFlag: false,
    renouncedMint: true,
    renouncedFreeze: true,
    creationTimestamp: nowSec - 3600, // 1 hour old
    openTimestamp: nowSec - 3600,
    priceChange1m: null,
    priceChange5m: null,
    priceChange1h: null,
    visitingCount: 0,
    squareMentions: 0,
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

describe('BotDetectionService', () => {
  it('clean token (no bot fields) is neutral: 0 risk, fail-open', () => {
    const r = new BotDetectionService().analyze(token());
    expect(r.botRisk).toBe(0);
    expect(r.severity).toBe('none');
    expect(r.needsBotKillSwitch).toBe(false);
    expect(r.reasons[0]).toContain('no bot evidence');
  });

  it('high bundlerRate trips the bundle signal and lifts risk', () => {
    const r = new BotDetectionService().analyze(token({ bundlerRate: 0.5 }));
    expect(r.signals.bundle).toBe(true);
    expect(r.signals.sniper).toBe(false);
    expect(r.botRisk).toBeGreaterThan(30);
  });

  it('young token + bundler → sniper-shaped entry', () => {
    const young = token({
      creationTimestamp: Math.floor(Date.now() / 1000) - 60, // 1 min old
      bundlerRate: 0.4,
    });
    const r = new BotDetectionService().analyze(young);
    expect(r.signals.bundle).toBe(true);
    expect(r.signals.sniper).toBe(true);
  });

  it('full fabrication profile clamps at 100 and demands a kill-switch trip', () => {
    const r = new BotDetectionService().analyze(
      token({
        creationTimestamp: Math.floor(Date.now() / 1000) - 60,
        bundlerRate: 0.9,
        top10HolderRate: 0.6,
        devTeamHoldRate: 0.3,
        ratTraderAmountRate: 0.2,
        isWashTrading: true,
      })
    );
    expect(r.signals.bundle).toBe(true);
    expect(r.signals.sniper).toBe(true);
    expect(r.signals.gradualBundle).toBe(true);
    expect(r.signals.washTrading).toBe(true);
    expect(r.botRisk).toBe(100);
    expect(r.needsBotKillSwitch).toBe(true);
  });

  it('gradual bundle requires bundling + linked/dev accumulation', () => {
    const r = new BotDetectionService().analyze(
      token({ bundlerRate: 0.4, ratTraderAmountRate: 0.2 })
    );
    expect(r.signals.bundle).toBe(true);
    expect(r.signals.gradualBundle).toBe(true);
  });
});

describe('severityFor', () => {
  it('maps 0-100 onto the five buckets', () => {
    expect(severityFor(90)).toBe('critical');
    expect(severityFor(70)).toBe('high');
    expect(severityFor(50)).toBe('medium');
    expect(severityFor(30)).toBe('low');
    expect(severityFor(5)).toBe('none');
  });
});

describe('BotRiskWindow', () => {
  it('records samples and snapshots avg + high-risk fraction', () => {
    const w = new BotRiskWindow();
    w.record(20);
    w.record(90);
    w.record(85);
    const s = w.snapshot(80);
    expect(s.avg).toBe(65);
    expect(s.highFraction).toBeCloseTo(2 / 3, 5);
    expect(s.sampleCount).toBe(3);
  });

  it('ignores non-finite samples and resets', () => {
    const w = new BotRiskWindow();
    w.record(NaN);
    expect(w.snapshot().sampleCount).toBe(0);
    w.record(50);
    w.reset();
    expect(w.snapshot().sampleCount).toBe(0);
  });
});
