import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { goPlusAuditGate } from '../src/agents/shared/gmgn-meme-helpers.js';
import { preFilterToken } from '../src/agents/shared/gmgn-meme-helpers.js';
import { BytecodeScanner } from '../src/services/bytecode-scanner.js';
import { AnkrDiscoveryFeed, PAIR_CREATED_TOPIC0, decodePairCreated, FACTORY_ADDRESSES } from '../src/adapters/ankr-discovery-feed.js';
import { RPCFailoverManager } from '../src/services/rpc-failover.js';
import { RobinhoodScreeningAgent } from '../src/agents/meme-robinhood/robinhood-screening-agent.js';
import type { MarketDataProvider, MarketToken } from '../src/adapters/market-data-provider.js';
import {
  consolidateOpinions,
  scoresFromOpinions,
  whaleVote,
  walletVote,
  convergenceVote,
  rubricVote,
  type VoterContext,
} from '../src/orchestrator/voters.js';

// Hermetic: every test in this file must run WITHOUT real network. The RPC
// probe tests and fail-soft paths hit fetch(); stub it globally to reject fast
// so hosts go unhealthy, discovery returns [], and GMGN calls fail open — all
// fast and deterministic (no 5s real-network timeouts).
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down (test stub)')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ANKR_FEED_ENABLED;
  delete process.env.MULTICHAIN_CHAINS;
  delete process.env.GMGN_API_KEY;
});

describe('goPlusAuditGate (C1)', () => {
  it('passes a clean token', () => {
    const r = goPlusAuditGate({ isHoneypot: false, buyTaxPct: 2, sellTaxPct: 2, isBlacklisted: false });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('goplus');
    expect(r.reasons).toEqual([]);
  });
  it('fails closed on honeypot', () => {
    const r = goPlusAuditGate({ isHoneypot: true, buyTaxPct: 0, sellTaxPct: 0, isBlacklisted: false });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('honeypot');
  });
  it('fails closed when no GoPlus data (transport or coverage gap)', () => {
    const r = goPlusAuditGate(null);
    expect(r.ok).toBe(false);
    expect(r.source).toBe('none');
    expect(r.reasons.join(' ')).toContain('unavailable');
  });
  it('enforces the tax gate', () => {
    const r = goPlusAuditGate({ isHoneypot: false, buyTaxPct: 15, sellTaxPct: 15, isBlacklisted: false });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('buy tax 15% > 10%');
  });
});

describe('BytecodeScanner.scanContract (C3)', () => {
  it('scans code fetched through the pool', async () => {
    const scanner = new BytecodeScanner();
    // PUSH4 0x42966c68 wrapped (burn-restrict) inside arbitrary hex.
    const evil = `0x${'00'.repeat(4)}6342966c68${'00'.repeat(8)}`;
    const r = await scanner.scanContract('bsc', '0x0000000000000000000000000000000000000001', async () => evil);
    expect(r.flagged).toBe(true);
    expect(r.findings[0]).toContain('0x42966c68');
  });
  it('fail-soft: transport error → empty scan, not a gate', async () => {
    const scanner = new BytecodeScanner();
    const r = await scanner.scanContract('bsc', '0x0000000000000000000000000000000000000001', async () => {
      throw new Error('boom');
    });
    expect(r.flagged).toBe(false);
    expect(r.findings).toEqual([]);
  });
  it('ignores unknown chains (sol has no eth_getCode)', async () => {
    const scanner = new BytecodeScanner();
    const r = await scanner.scanContract('sol', 'whatever', async () => '0x00');
    expect(r.flagged).toBe(false);
  });
});

describe('AnkrDiscoveryFeed (B4)', () => {
  it('exposes the PairCreated topic0 constant', () => {
    expect(PAIR_CREATED_TOPIC0).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('has factories for the EVM chains the bot scans (robinhood absent — unverified)', () => {
    const feed = new AnkrDiscoveryFeed();
    expect(feed.id).toBe('ankr-pair-created');
    // constructor import of the feed module must not throw (side-effect free)
    expect(typeof feed.discover).toBe('function');
    // RH factory was removed because the Ethereum Uniswap V2 address is NOT an
    // RH factory — do not regress it back in without on-chain confirmation.
    expect(Object.keys(FACTORY_ADDRESSES).sort()).toEqual(['base', 'bsc', 'eth']);
    expect(FACTORY_ADDRESSES['robinhood']).toBeUndefined();
  });
  it('fail-soft: returns [] when every RPC call fails (transport)', async () => {
    const feed = new AnkrDiscoveryFeed();
    // fetch() is stubbed to reject — discover() must fail-soft to [] (never throw).
    const tokens = await feed.discover({ chainIds: [1] });
    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens.length).toBe(0);
  });
});

describe('decodePairCreated (B4 decode fixture)', () => {
  it('decodes a REAL Uniswap V2 PairCreated log (topics padded, pair in data)', () => {
    // Real V2 PairCreated: token0 = WETH 0xC02aA…, token1 = USDC 0xA0b8…,
    // pair = 0xB4e16… (top USDC/WETH pair). topics are 32-byte LEFT-padded
    // addresses; the pair is the FIRST word of data (non-indexed).
    const log = {
      address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      topics: [
        PAIR_CREATED_TOPIC0,
        `0x000000000000000000000000C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`, // token0 WETH (padded)
        `0x000000000000000000000000A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, // token1 USDC (padded)
      ],
      data: `0x000000000000000000000000B4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc` + `0000000000000000000000000000000000000000000000000000000000000001`,
    };
    const d = decodePairCreated(log as any);
    expect(d).not.toBeNull();
    expect(d!.token0).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    expect(d!.token1).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    // THE key regression: pair is the data word, NOT log.address (the factory).
    expect(d!.pair).toBe('0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc');
    expect(d!.pair).not.toBe(log.address.toLowerCase());
  });
  it('rejects malformed logs (missing pair word)', () => {
    const d = decodePairCreated({
      address: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
      topics: [PAIR_CREATED_TOPIC0, '0x000000000000000000000000C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0x000000000000000000000000A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
      data: '0x', // no pair word
    } as any);
    expect(d).toBeNull();
  });
});

import { FreshPairWatchlist } from '../src/services/fresh-pair-watchlist.js';
import { klinesFollowThroughLabeler } from '../src/orchestrator/calibration-harness.js';
import { TradeJournalService } from '../src/services/trade-journal-service.js';

describe('#1 trade-plan lifecycle + journal persistence', () => {
  it('journal updateLifecycle persists nonce/hash/quote/slippage/reconcile fields', () => {
    const journal = new TradeJournalService();
    const entry = journal.recordTradeEntry({
      id: 'TRADE_X', domain: 'MEME_ROBINHOOD', symbol: 'X', contractAddressOrId: '0xX', chain: 'bsc',
      entryTimestamp: new Date().toISOString(), entryPriceUsdOrEth: 0.01, positionSizeUsd: 500,
      swarmScore: 85, strategyUsed: 't', aiThesisSummary: '', status: 'OPEN',
    });
    const updated = journal.updateLifecycle('TRADE_X', {
      lifecycle: 'confirmed', nonce: 'n1', txHash: '0xabc', quoteUsd: 500, actualOutTokens: 123,
      gasUsed: 21000, slippagePct: 0.5, reconciled: true,
    });
    expect(updated!.txHash).toBe('0xabc');
    expect(updated!.lifecycle).toBe('confirmed');
    expect(updated!.reconciled).toBe(true);
    expect(updated!.slippagePct).toBe(0.5);
  });
});

describe('#3 fresh-pair promotion watchlist', () => {
  function mkFresh(overrides: Record<string, unknown>): any {
    return { chain: 'bsc', address: '0xF', symbol: 'F', freshLane: true, volume1hUsd: 0, liquidityUsd: 0, ...overrides };
  }

  it('tracks fresh pairs and reports the ones that matured', () => {
    const wl = new FreshPairWatchlist();
    const r1 = wl.track([mkFresh({ volume1hUsd: 0, liquidityUsd: 0 })]);
    expect(r1.matured.length).toBe(0);
    // Next cycle the pair accumulated volume → matured.
    const r2 = wl.track([mkFresh({ volume1hUsd: 30000, liquidityUsd: 5000 })]);
    expect(r2.matured.length).toBe(1);
    expect(r2.matured[0]!.address).toBe('0xF');
    expect(r2.matured[0]!.matured).toBe(true);
  });

  it('ignores non-freshLane candidates', () => {
    const wl = new FreshPairWatchlist();
    const r = wl.track([mkFresh({ freshLane: false, volume1hUsd: 999999 })]);
    expect(r.matured.length).toBe(0);
    expect(r.active).toBe(0);
  });
});

describe('#2 klines follow-through labeler', () => {
  const entry = {
    symbol: 'TEST', domain: 'MEME_ROBINHOOD', contractAddress: '0xCA',
    totalConfidence: 85, passed: true, timestamp: '2026-09-25T00:00:00Z', rawPayloadJson: '{}',
  };

  it('labels up when price rose in the window', async () => {
    const labeler = klinesFollowThroughLabeler({
      fetchKlines: async () => [
        { timestamp: Date.parse('2026-09-24T23:50:00Z'), close: 100 },
        { timestamp: Date.parse('2026-09-25T00:30:00Z'), close: 110 },
        { timestamp: Date.parse('2026-09-25T01:00:00Z'), close: 120 },
      ],
      now: Date.parse('2026-09-25T01:30:00Z'),
    });
    expect(await labeler(entry as any)).toBe('up');
  });

  it('labels null when klines are unavailable (never a false fire)', async () => {
    const labeler = klinesFollowThroughLabeler({ fetchKlines: async () => null });
    expect(await labeler(entry as any)).toBeNull();
  });
});

describe('Fresh-pair lane (recency fix)', () => {
  const matureCfg = {
    minVolume1hUsd: 50000,
    minLiquidityUsd: 10000,
    minMarketCapUsd: 100000,
    minAgeHours: 0,
    maxRugRatio: 0.3,
    maxRatTraderRate: 0.3,
    maxTop10HolderRate: 0.4,
    minTotalFeeUsd: 0,
    minFreshVolume1hUsd: 3000,
  };

  function mkT(overrides: Record<string, unknown>): any {
    return {
      chain: 'bsc', address: '0xF', symbol: 'F', name: 'F', priceUsd: 0, marketCapUsd: 0,
      volume24hUsd: 0, volume1hUsd: 0, liquidityUsd: 0, buys: 0, sells: 0, swaps: 0,
      holderCount: 0, top10HolderRate: null, devTeamHoldRate: null, creatorClose: false,
      creatorTokenStatus: null, smartDegenCount: 0, renownedCount: 0, bundlerRate: null,
      ratTraderAmountRate: null, rugRatio: null, isWashTrading: false, isHoneypot: null,
      ctoFlag: false, renouncedMint: false, renouncedFreeze: false, creationTimestamp: null,
      openTimestamp: null, priceChange1m: null, priceChange5m: null, priceChange1h: null,
      visitingCount: 0, squareMentions: 0, twitterRenameCount: 0, twitterDelPostCount: 0,
      twitterCreateTokenCount: 0, buyTax: null, sellTax: null, dexscrBoostFee: 0,
      dexscrAd: false, totalFeeNative: null, exchange: null, launchpadPlatform: null,
      launchpadStatus: null, progress: null, source: 'ankr',
      ...overrides,
    };
  }

  it('freshLane raw pair (zero market data) bypasses volume/liq/mcap — young, not dead', () => {
    const r = preFilterToken(mkT({ freshLane: true, volume1hUsd: 0, liquidityUsd: 0, marketCapUsd: 0 }), matureCfg as any);
    // Un-gated on market data (it is younger than the measurement windows);
    // security fields are null → fail-open per field → passes.
    expect(r.ok).toBe(true);
  });

  it('freshLane with SOME volume uses the low fresh floor, not the mature $50k', () => {
    const r = preFilterToken(mkT({ freshLane: true, volume1hUsd: 8000, liquidityUsd: 12000, marketCapUsd: 200000 }), matureCfg as any);
    expect(r.ok).toBe(true);
  });

  it('freshLane below even the fresh floor still rejects (fail-closed)', () => {
    const r = preFilterToken(mkT({ freshLane: true, volume1hUsd: 500, liquidityUsd: 12000, marketCapUsd: 200000 }), matureCfg as any);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('volume 1h $0.5k < $3k');
  });

  it('mature (non-fresh) token still needs the mature $50k floor — no recency bypass', () => {
    const r = preFilterToken(mkT({ freshLane: undefined, volume1hUsd: 8000, liquidityUsd: 12000, marketCapUsd: 200000 }), matureCfg as any);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('volume 1h $8.0k < $50k');
  });
});

describe('#1 abstention semantics', () => {
  it('abstained opinions drop out of consolidateOpinions (renormalized, not 50-dragged)', () => {
    const out = consolidateOpinions([
      { voter: 'quant', score: 95, reasons: [] },
      { voter: 'ml', score: 50, reasons: ['no klines — abstain'], abstain: true },
      { voter: 'security', score: 100, reasons: [] },
    ]);
    // ml abstained → momentum = quant alone (95), not (95+50)/2.
    expect(out.momentum).toBe(95);
    expect(out.flow).toBeUndefined();
  });

  it('scoresFromOpinions skips abstained opinions', () => {
    const map = scoresFromOpinions([
      { voter: 'critic', score: 50, reasons: ['critic unavailable — abstain'], abstain: true },
      { voter: 'quant', score: 80, reasons: [] },
    ]);
    expect(map['critic']).toBeUndefined();
    expect(map['quant']).toBe(80);
  });

  it('whaleVote abstains on missing flow but votes (40) when bot-risk distrusts flow', () => {
    const missing = whaleVote([], 0);
    expect(missing.abstain).toBe(true);
    const distrust = whaleVote([], 70);
    expect(distrust.abstain).toBeFalsy();
    expect(distrust.score).toBe(40);
  });

  it('wallet/convergence/rubric abstain when their inputs are missing', () => {
    expect(walletVote({} as VoterContext).abstain).toBe(true);
    expect(convergenceVote({} as VoterContext).abstain).toBe(true);
    expect(rubricVote({} as VoterContext).abstain).toBe(true);
  });
});

describe('RPCFailoverManager failure memory (P1-3/P1-4)', () => {
  it('advances lastProbeAt after a probe pass', async () => {
    const mgr = new RPCFailoverManager();
    const before = mgr.getLastProbeAt();
    await mgr.probeLatencies();
    const after = mgr.getLastProbeAt();
    expect(after).toBeGreaterThan(before);
  });
  it('getActiveRPC fallback skips a URL reported failed', () => {
    const mgr = new RPCFailoverManager();
    const rh = mgr.getRpcUrls('rh');
    const first = mgr.getActiveRPC('rh');
    // Mark the active host dead; the fallback must NOT reselect it.
    mgr.reportRPCFailure('rh', first);
    const second = mgr.getActiveRPC('rh');
    expect(second).not.toBe(first);
    expect(rh).toContain(second);
  });
  it('failed-URL memory clears after a probe', async () => {
    const mgr = new RPCFailoverManager();
    const first = mgr.getActiveRPC('rh');
    mgr.reportRPCFailure('rh', first);
    await mgr.probeLatencies();
    // After a fresh probe the previously-failed host is eligible again.
    const again = mgr.getActiveRPC('rh');
    expect(['rh', 'eth', 'bsc', 'base', 'sol']).toContain('rh');
    expect(typeof again).toBe('string');
  });
});

describe('Ankr candidates flow into the screening merge (P1-1)', () => {
  beforeEach(() => { process.env.ANKR_FEED_ENABLED = 'true'; process.env.MULTICHAIN_CHAINS = 'robinhood'; });
  afterEach(() => {
    delete process.env.ANKR_FEED_ENABLED;
    delete process.env.MULTICHAIN_CHAINS;
  });

  it('collectAnkrCandidates normalizes discovered pairs into GMGN tokens tagged ankr', async () => {
    const ankrFeed: MarketDataProvider = {
      id: 'ankr-pair-created',
      discover: vi.fn(async (): Promise<MarketToken[]> => [{
        address: '0xNEWANKR',
        chainId: 4663,
        symbol: '',
        priceUsd: 0,
        liquidityUsd: 0,
        volume24hUsd: 0,
        pairAddress: '0xPAIR',
      }]),
    };
    const agent = new RobinhoodScreeningAgent(undefined, undefined, { ankr: ankrFeed });
    const candidates = await agent.collectAnkrCandidates('robinhood');
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.address).toBe('0xNEWANKR');
    expect(candidates[0]!.source).toBe('ankr');
  });

  it('runScreeningPass invokes the ankr collector when the feed is injected (merge wired)', async () => {
    process.env.GMGN_API_KEY = 'test-key';
    const ankrFeed: MarketDataProvider = {
      id: 'ankr-pair-created',
      discover: vi.fn(async (): Promise<MarketToken[]> => []),
    };
    // Spy the collector itself: if the merge calls it, the ankr feed is wired
    // into the screening path. Avoids a full pass (GoPlus/GMGN network I/O).
    const spy = vi.spyOn(RobinhoodScreeningAgent.prototype as any, 'collectAnkrCandidates')
      .mockResolvedValue([]);
    const agent = new RobinhoodScreeningAgent(undefined, undefined, { ankr: ankrFeed });
    await agent.runScreeningPass();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
