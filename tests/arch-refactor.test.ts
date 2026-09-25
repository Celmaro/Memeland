import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SwarmConsensusEngine } from '../src/orchestrator/swarm-consensus.js';
import { sweepThresholds, type CalibrationRow } from '../src/orchestrator/calibration-harness.js';
import { antiFoolingRisk, antiFoolingPenalties } from '../src/services/anti-fooling.js';
import { gateSizer } from '../src/services/execution-gates.js';
import { consolidateOpinions } from '../src/orchestrator/voters.js';
import type { GMGNRawToken } from '../src/adapters/gmgn-adapter.js';

beforeEach(() => {
  SwarmConsensusEngine.setStrategyProvider(null);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down (test stub)')));
});

describe('#1 security hard-gate in swarm-consensus', () => {
  const engine = new SwarmConsensusEngine();
  const base = {
    symbol: 'TEST', domain: 'MEME_ROBINHOOD' as const, contractAddress: '0xabc',
    liquidityUsd: 60000, volume1hUsd: 120000, securityAuditPassed: true, socialHypeScore: 80,
  };

  it('refuses BEFORE averaging when the security vote is below the 70 hard floor', () => {
    const res = engine.evaluateSignal({
      ...base,
      voterScores: { momentum: 100, flow: 100, security: 50, sentiment: 90, critic: 90 },
    });
    expect(res.passed).toBe(false);
    // The weighted average would be ~86 — the hard gate must veto it anyway.
    expect(res.decision?.refusal).toBe('SECURITY');
    expect(res.breakdown.voters?.security).toBe(50);
  });

  it('passes a security-100 candidate with strong momentum', () => {
    const res = engine.evaluateSignal({
      ...base,
      voterScores: { momentum: 95, flow: 85, security: 100, sentiment: 80, critic: 80 },
    });
    expect(res.passed).toBe(true);
  });
});

describe('#2 offline calibration harness', () => {
  it('sweeps thresholds and earns a floor from precision/recall', () => {
    const rows: CalibrationRow[] = [
      { symbol: 'A', confidenceScore: 90, passed: false, followThrough: 'up' },
      { symbol: 'B', confidenceScore: 90, passed: false, followThrough: 'up' },
      { symbol: 'D', confidenceScore: 80, passed: false, followThrough: 'up' },
      { symbol: 'E', confidenceScore: 62, passed: false, followThrough: 'down' },
      { symbol: 'F', confidenceScore: 55, passed: false, followThrough: 'down' },
    ];
    const rep = sweepThresholds(rows, { minPrecision: 0.5, minRecall: 0.3 });
    // 3 ups total. At T=90: 2/2 >= 90 are up (precision 1.0), recall 2/3.
    expect(rep.upTotal).toBe(3);
    const t90 = rep.thresholds.find((t) => t.threshold === 90)!;
    expect(t90.precision).toBe(1.0);
    expect(t90.recall).toBeCloseTo(2 / 3, 5);
    // At T=80: 3/3 up (precision 1.0), recall 1.0 → recommended floor = 90 (highest meeting both).
    expect(rep.recommendedFloor).toBe(90);
    expect(rep.rationale).toContain('Earned floor');
  });

  it('reports no floor when precision never clears the bar (honest calibration failure)', () => {
    const rows: CalibrationRow[] = [
      { symbol: 'A', confidenceScore: 90, passed: false, followThrough: 'down' },
      { symbol: 'B', confidenceScore: 85, passed: false, followThrough: 'down' },
    ];
    const rep = sweepThresholds(rows, { minPrecision: 0.5 });
    expect(rep.recommendedFloor).toBeNull();
    expect(rep.rationale).toContain('No threshold met');
  });
});

describe('#3 deterministic anti-fooling layer', () => {
  function mkToken(overrides: Partial<GMGNRawToken> = {}): GMGNRawToken {
    return {
      chain: 'bsc' as const, address: '0xX', symbol: 'X', name: 'X',
      priceUsd: 0, marketCapUsd: 0, volume24hUsd: 0, volume1hUsd: 0, liquidityUsd: 0,
      buys: 0, sells: 0, swaps: 0, holderCount: 0,
      top10HolderRate: null, devTeamHoldRate: null, creatorClose: false, creatorTokenStatus: null,
      smartDegenCount: 0, renownedCount: 0, bundlerRate: null, ratTraderAmountRate: null,
      rugRatio: null, isWashTrading: false, isHoneypot: null, ctoFlag: false,
      renouncedMint: false, renouncedFreeze: false, creationTimestamp: null, openTimestamp: null,
      priceChange1m: null, priceChange5m: null, priceChange1h: null,
      visitingCount: 0, squareMentions: 0,
      twitterRenameCount: 0, twitterDelPostCount: 0, twitterCreateTokenCount: 0,
      buyTax: null, sellTax: null, dexscrBoostFee: 0, dexscrAd: false, totalFeeNative: null,
      exchange: null, launchpadPlatform: null, launchpadStatus: null, progress: null,
      source: 'dexscreener' as const,
      ...overrides,
    };
  }

  it('flags the launch-bundle: high bundlerRate + high concentration = fooled', () => {
    const r = antiFoolingRisk(mkToken({ bundlerRate: 0.5, top10HolderRate: 0.6 }));
    expect(r.fooled).toBe(true);
    expect(r.reasons.join(' ')).toContain('launch-bundle');
  });

  it('flags the sellability contradiction: claimed liquidity but sell fails', () => {
    const r = antiFoolingRisk(mkToken({ liquidityUsd: 80000 }), { sellable: false, sellReasons: ['quoter reverted'] });
    expect(r.foolingRisk).toBeGreaterThanOrEqual(40);
    expect(r.reasons.join(' ')).toContain('sellability contradiction');
  });

  it('is quiet for a clean token (no fooling, not fooled)', () => {
    const r = antiFoolingRisk(mkToken());
    expect(r.fooled).toBe(false);
    expect(r.foolingRisk).toBe(0);
  });

  it('antiFoolingPenalties is empty unless fooled (a soft risk does not hard-reject)', () => {
    expect(antiFoolingPenalties({ foolingRisk: 15, fooled: false, reasons: ['elevated bundlerRate'], degraded: false })).toEqual([]);
    expect(antiFoolingPenalties({ foolingRisk: 55, fooled: true, reasons: ['launch-bundle'], degraded: false }).length).toBe(1);
  });
});

describe('#4 consolidateOpinions maps fine-grained voters to the 5 slots', () => {
  it('blends quant+ml → momentum, whale+wallet+convergence → flow, critic+rubric → critic', () => {
    const out = consolidateOpinions([
      { voter: 'quant', score: 90, reasons: [] },
      { voter: 'ml', score: 70, reasons: [] },
      { voter: 'whale', score: 60, reasons: [] },
      { voter: 'wallet', score: 80, reasons: [] },
      { voter: 'convergence', score: 40, reasons: [] },
      { voter: 'security', score: 100, reasons: [] },
      { voter: 'sentiment', score: 75, reasons: [] },
      { voter: 'critic', score: 90, reasons: [] },
      { voter: 'rubric', score: 70, reasons: [] },
    ]);
    expect(out.momentum).toBe(80);            // (90+70)/2
    expect(out.flow).toBe(60);                // (60+80+40)/3
    expect(out.security).toBe(100);
    expect(out.sentiment).toBe(75);
    expect(out.critic).toBe(80);              // (90+70)/2
  });
});

describe('#5 edge→sizing', () => {
  it('scales DOWN weak conviction and thin liquidity inside the envelope', () => {
    const sizer = gateSizer();
    // env MAX_NOTIONAL_USD default 2000; edge scale 0.5 (conf 80), liq scale 0.5 (depth <=5k)
    const r = sizer.clamp(2000, { confidence: 80, liquidityUsd: 4000 });
    expect(r.allowed).toBe(true);
    expect(r.amountUsd).toBe(500); // 2000 * 0.5 * 0.5
    expect(r.reason).toContain('edge scale');
  });

  it('never exceeds the max notional even at full confidence + deep liquidity', () => {
    const sizer = gateSizer();
    const r = sizer.clamp(2000, { confidence: 100, liquidityUsd: 200000 });
    expect(r.allowed).toBe(true);
    expect(r.amountUsd).toBeLessThanOrEqual(2000);
  });

  it('missing confidence/liquidity is conservative (floor multipliers)', () => {
    const sizer = gateSizer();
    const r = sizer.clamp(2000, {});
    expect(r.amountUsd).toBe(500); // conf 0 → 0.5 floor, liq 0 → 0.5 floor
  });
});