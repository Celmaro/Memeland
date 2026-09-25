import { GMGNAdapter, GMGNRawToken, type Chain, type KlineCandle } from '../../adapters/gmgn-adapter.js';
import { RhFillTapeReader } from '../../adapters/rh-fill-tape.js';
import { chainIdFor, type MarketDataProvider } from '../../adapters/market-data-provider.js';
import { globalPriceFeedService } from '../../services/price-feed-service.js';
import { globalBotDetection, recordBotRiskSample } from '../../services/bot-detection.js';
import { globalRugScoring } from '../../services/rug-scoring.js';
import { antiFoolingRisk, antiFoolingPenalties } from '../../services/anti-fooling.js';
import { BytecodeScanner } from '../../services/bytecode-scanner.js';
import { SellabilitySimulator } from '../../services/sellability/sellability-simulator.js';
import { StrategyEngine } from '../../orchestrator/strategy-engine.js';
import type { ScreeningAgent, AgentReport, CallCardPayload } from '../shared/agent-contract.js';
import { GoPlusSecurityService } from '../../services/goplus-security-service.js';
import { BlockscoutFeed, blockscoutFeedEnabled } from '../../adapters/blockscout-feed.js';
import { createDedupe, preFilterToken, detectMemeSignal, volume24hOf, buildSignalBoostMap, applySignalBoost, toStrategyGmgn, buildMemeThesis, isGraduatedToken, validateMemeConfigUpdate, securityAuditGate, goPlusAuditGate, buildTrackAccumulation, trackAccumulationLabel } from '../shared/gmgn-meme-helpers.js';
import type { SignalBoostMap, TrackAccumulation, MemePreFilterConfig } from '../shared/gmgn-meme-helpers.js';
import { discoveryFiltersForChain, normalizeTapeWindow, normalizeDexToken } from './robinhood-discovery.js';
import { SentimentVoter } from '../shared/sentiment-voter.js';
import { DexScreenerBoostsFeed } from '../../adapters/dexscreener-boosts.js';
import { CriticVoter } from '../shared/critic-voter.js';
import { predictUpMomentum, fetchKlinesWithGeckoFallback, geckoNetworkIdFor } from '../shared/ml-predictor.js';
import {
  type VoterOpinion, type VoterContext, consolidateOpinions,
  whaleVote, securityVote, walletVote, rubricVote,
  reputationAwareSecurityVote, reputationAwareWalletVote, reputationContextFromToken,
  stickyQuantVote, ownerDedupedConvergenceVote,
} from '../../orchestrator/voters.js';
import { globalReputationMemory } from '../../services/reputation-memory.js';
import { globalDecisionCache } from '../../services/decision-cache.js';

export interface RobinhoodSignal {
  token: GMGNRawToken;
  signalType: 'CTO' | 'REVIVAL' | 'MOMENTUM' | 'NONE';
  confidence: number;
  reasons: string[];
}

export interface RobinhoodScreeningConfig {
  minVolume1hUsd: number;    // 50000 — real 1-HOUR volume (token must be active RIGHT NOW)
  minLiquidityUsd: number;   // 10000
  minMarketCapUsd: number;   // 100000 — required to be above $100k (MC 0/unknown = reject)
  minAgeHours: number;       // 0 — degen early: new tokens pass immediately (smart money/CTO/KOL decide)
  maxRugRatio: number;       // 0.3
  maxRatTraderRate: number;  // 0.3
  maxTop10HolderRate: number;// 0.4
  minTotalFeeUsd: number;    // 500 — active fee gate: tokens without organic activity (unrecorded fee) rejected
  minFreshVolume1hUsd: number; // 3000 — fresh-pair lane floor (ankr/gecko raw pairs)
  passThreshold: number;     // 80
  signalTypes: number[];     // smart-money/KOL/CTO/price events (overlay boost)
  rankLimit: number;         // 100 (trending, 1h)
  trenchesLimit: number;     // 80 (completed only)
  hotSearchesLimit: number;  // 100 (hot searches, migrated)
  trackFeedEnabled: boolean; // true — smart-money trade feed = additional candidates (booster, not replacement)
  minTrackWallets: number;   // 2 — minimum smart-money wallets buying the same token
  minTrackBuyUsd: number;    // 10000 — minimum total buy USD
  trackFreshMinutes: number; // 30 — fresh accumulation window
}

const DEFAULT_CONFIG: RobinhoodScreeningConfig = {
  minVolume1hUsd: 50000,
  minLiquidityUsd: 10000,
  minMarketCapUsd: 100000,
  minAgeHours: 0,
  maxRugRatio: 0.3,
  maxRatTraderRate: 0.3,
  maxTop10HolderRate: 0.4,
  minTotalFeeUsd: 500,
  minFreshVolume1hUsd: 3000,
  passThreshold: 80,
  // 6 PriceUp, 7 PriceATH, 8 McpKeyLevel, 11 Cto, 12 SmartDegenBuy, 13/19 PlatformCall, 20 KOLBuy
  signalTypes: [6, 7, 8, 11, 12, 13, 19, 20],
  rankLimit: 100,
  trenchesLimit: 80,
  hotSearchesLimit: 100,
  trackFeedEnabled: true,
  minTrackWallets: 2,
  minTrackBuyUsd: 10000,
  trackFreshMinutes: 30,
};

export class RobinhoodScreeningAgent implements ScreeningAgent<RobinhoodSignal> {
  // Memeland fork: the agent class is still named after its origin (Robinhood) but it now
  // runs on the full 5-chain scope (sol,bsc,base,eth,robinhood). Log prefix [MEME AGENT]
  // (was [ROBINHOOD AGENT]) so the cycle output reflects the fork's multichain identity,
  // not the legacy single-chain brand. The 'meme-robinhood' domain key is preserved
  // because Discord channels, funnel state-store keys, and runtime config all key on it.
  readonly domain = 'meme-robinhood';
  private gmgn: GMGNAdapter;
  private priceFeed = globalPriceFeedService;
  private strategyEngine: StrategyEngine;
  private config: RobinhoodScreeningConfig;
  private strategyParams?: () => Record<string, unknown>;
  private dedupeTokens = createDedupe();

  /** Arch-3 7-voter swarm — OFF by default (legacy path for tests); index.ts enables via env/opts. */
  private voterSwarm: boolean;
  private criticVoter: CriticVoter | null;
  private sentimentVoter: SentimentVoter;

  /** Q04 fill-tape transport (per-token corroboration). Empty until injected. */
  private tape: RhFillTapeReader | null;
  /** Q04 tape token addresses to probe (the transport's enumeration). */
  private tapeTokenAddresses: string[];
  /** Q06 keyless DexScreener feed. Empty until injected. */
  private dexscreener: MarketDataProvider | null;
  /** PR7 keyless DEXPaprika feed. Empty until injected. */
  private dexpaprika: MarketDataProvider | null;
  /** SRC-153 keyless GeckoTerminal discovery feed (new_pools + trending). Empty until injected. */
  private gecko: MarketDataProvider | null;
  /** B4 keyless on-chain PairCreated discovery feed (Ankr-style, pool-backed). Empty until injected. */
  private ankr: MarketDataProvider | null;
  /** Kernel D deterministic bytecode scan for EVM tokens that carry hex. */
  private bytecodeScanner: BytecodeScanner;
  /** Kernel D round-trip sell proof, fail-closed until a pass is proven. */
  private sellability: SellabilitySimulator;
  /** Keyless EVM token-security audit (GoPlus) — primary before GMGN. */
  private goplusService: GoPlusSecurityService;
  /** I0-1 Blockscout BuyEvent producer for the convergence voter (env-gated). */
  private blockscout: BlockscoutFeed | null;

  /** Last pass funnel stats — consumed by index.ts for the Phase-1 [FUNNEL] counters. */
  private lastFunnel: { scanned: number; prefiltered: number; emitted: number } = { scanned: 0, prefiltered: 0, emitted: 0 };

  constructor(
    config?: Partial<RobinhoodScreeningConfig>,
    strategyParams?: () => Record<string, unknown>,
    opts: {
      voterSwarm?: boolean;
      critic?: CriticVoter | null;
      tape?: RhFillTapeReader;
      tapeTokenAddresses?: string[];
      dexscreener?: MarketDataProvider;
      dexpaprika?: MarketDataProvider;
      gecko?: MarketDataProvider;
      ankr?: MarketDataProvider | null;
      bytecodeScanner?: BytecodeScanner;
      sellability?: SellabilitySimulator;
      blockscout?: BlockscoutFeed | null;
    } = {}
  ) {
    this.gmgn = new GMGNAdapter();
    this.strategyEngine = new StrategyEngine();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.strategyParams = strategyParams;
    this.voterSwarm = opts.voterSwarm ?? process.env.VOTER_SWARM_ENABLED === 'true';
    this.criticVoter = opts.critic ?? null;
    this.sentimentVoter = new SentimentVoter(
      undefined,
      process.env.DEXSCREENER_BOOSTS_ENABLED === 'true' ? new DexScreenerBoostsFeed() : null,
    );
    this.tape = opts.tape ?? null;
    this.tapeTokenAddresses = opts.tapeTokenAddresses ?? [];
    this.dexscreener = opts.dexscreener ?? null;
    this.dexpaprika = opts.dexpaprika ?? null;
    this.gecko = opts.gecko ?? null;
    this.ankr = opts.ankr ?? null;
    this.bytecodeScanner = opts.bytecodeScanner ?? new BytecodeScanner();
    this.sellability = opts.sellability ?? new SellabilitySimulator(() => ({ simulated: false, sellable: false }));
    this.goplusService = new GoPlusSecurityService();
    this.blockscout = opts.blockscout ?? null;
  }

  /**
   * Runtime config update (chat tool `set_screening_config`). Whitelisted keys
   * only; invalid values are rejected, never silently clamped.
   */
  public updateConfig(partial: Record<string, unknown>): { applied: Record<string, unknown>; rejected: string[] } {
    const { applied, rejected } = validateMemeConfigUpdate(partial);
    this.config = { ...this.config, ...applied };
    if (Object.keys(applied).length > 0) {
      console.log(`[MEME AGENT] Config updated: ${JSON.stringify(applied)}`);
    }
    return { applied, rejected };
  }

  public getConfig(): RobinhoodScreeningConfig {
    return { ...this.config };
  }

  /**
   * 3 data sources, all focused on GRADUATED tokens (already on DEX, not
   * bonding curve) with a 1H timeframe:
   * 1. Trending rank (interval 1h, is_out_market filter) — tokens currently rising
   * 2. Trenches completed — just finished bonding curve -> DEX
   * 3. Hot searches (migrated) — most-searched tokens
   * NOTE: token_signal (smart-money/KOL/CTO events) dropped as a candidate source:
   * GMGN never fills volume/swaps for non-SOL chains & fees are < $100 — that
   * source always dies at the volume/fee gate (investigated 2026-08-08).
   * Chain-aware filters: 'renounced' is Solana-only; EVM chains drop it.
   */
  public async collectCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    const evm = chain !== 'sol';
    const baseFilters = discoveryFiltersForChain(chain);
    const [rank, trenches, hotSearches] = await Promise.all([
      this.gmgn.fetchRank(chain, {
        interval: '1h',
        limit: this.config.rankLimit,
        filters: baseFilters,
      }),
      this.gmgn.fetchTrenches(chain, {
        types: ['completed'],
        limit: this.config.trenchesLimit,
        filters: { max_rug_ratio: 0.3, max_insider_ratio: 0.3 },
      }),
      this.gmgn.fetchHotSearches({ chain, interval: '1h', limit: this.config.hotSearchesLimit, filters: ['migrated', 'not_honeypot', 'verified', ...(evm ? [] : ['renounced'])] }),
    ]);

    const candidates = [
      ...rank,
      ...trenches.completed,
      ...hotSearches,
    ];
    return this.dedupeTokens.dedupe(candidates);
  }

  /**
   * Q04 fill-tape additional candidates (BOOSTER, not a replacement). Guarded by
   * env RH_TAPE_ENABLED=true (default off). Active only when a tape transport
   * (RhFillTapeReader + token addresses) is injected. Normalizes each probed
   * token's tape window into a GMGNRawToken with source 'dexscreener' (the only
   * non-gmgn member of the source union). Fail-open: empty on any error/unconfigured.
   */
  public async collectTapeCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    if (process.env.RH_TAPE_ENABLED !== 'true') return [];
    if (!this.tape || this.tapeTokenAddresses.length === 0) return [];
    try {
      const out: GMGNRawToken[] = [];
      for (const address of this.tapeTokenAddresses) {
        const window = await this.tape.readFillTape(address);
        if (!window || window.failOpen || !window.entries || window.entries.length === 0) continue;
        out.push(normalizeTapeWindow(chain, window));
      }
      return out;
    } catch (err: any) {
      console.warn(`[MEME AGENT] Fill-tape candidates failed (skipped): ${err.message}`);
      return [];
    }
  }

  /**
   * Q06 keyless DexScreener additional candidates (BOOSTER). Guarded by env
   * DEXSCREENER_FEED_ENABLED=true (default off). Active only when a DexScreener
   * feed is injected. Normalizes discovered MarketTokens (filtered to the current
   * chain) into GMGNRawToken with source 'dexscreener'. Fail-open: empty.
   */
  public async collectDexscreenerCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    return this.collectProviderCandidates(this.dexscreener, 'dexscreener', 'DEXSCREENER_FEED_ENABLED', chain);
  }

  /** PR7 DEXPaprika keyless feed candidates (BOOSTER). Guarded by DEXPAPRIKA_FEED_ENABLED=true. */
  public async collectDexpaprikaCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    return this.collectProviderCandidates(this.dexpaprika, 'dexpaprika', 'DEXPAPRIKA_FEED_ENABLED', chain);
  }

  /** SRC-153 GeckoTerminal keyless discovery candidates. Guarded by GECKO_FEED_ENABLED=true. */
  public async collectGeckoCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    return this.collectProviderCandidates(this.gecko, 'gecko', 'GECKO_FEED_ENABLED', chain);
  }

  /** B4 on-chain PairCreated discovery candidates. Guarded by ANKR_FEED_ENABLED=true. */
  public async collectAnkrCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    return this.collectProviderCandidates(this.ankr, 'ankr', 'ANKR_FEED_ENABLED', chain);
  }

  /**
   * Shared keyless-feed collector. Fails open (empty) unless the env gate is on
   * and a provider is injected. Normalizes discovered MarketTokens (filtered to
   * the current chain) into GMGNRawToken tagged with the source name.
   */
  private async collectProviderCandidates(
    provider: MarketDataProvider | null,
    source: 'gmgn' | 'dexscreener' | 'dexpaprika' | 'gecko' | 'ankr',
    envVar: string,
    chain: Chain = 'robinhood',
  ): Promise<GMGNRawToken[]> {
    if (process.env[envVar] !== 'true') return [];
    if (!provider) return [];
    try {
      const chainId = chainIdFor(chain);
      const tokens = await provider.discover({ chainIds: chainId !== undefined ? [chainId] : [] });
      return tokens.map((t) => normalizeDexToken(chain, t, source));
    } catch (err: any) {
      console.warn(`[MEME AGENT] ${source} candidates failed (skipped): ${err.message}`);
      return [];
    }
  }

  /**
   * Signal booster map (analytical overlay, NOT a candidate source): GMGN
   * token_signal never fills volume/swaps (any chain), so its events are used
   * to boost confidence on tokens that already pass rank/trenches/hot gates.
   * Fail-open: any error -> empty map, screening proceeds unchanged.
   */
  public async collectSignalBoostMap(chain: Chain = 'robinhood'): Promise<SignalBoostMap> {
    // GMGN token_signal has NO base/eth coverage (sol/bsc/robinhood/arc/stable only).
    // Degrade silently per non-negotiable #4: base/eth runs without the overlay.
    if (chain === 'base' || chain === 'eth') return new Map();
    try {
      const events = await this.gmgn.fetchTokenSignals(chain, this.config.signalTypes);
      return buildSignalBoostMap(events);
    } catch (err: any) {
      console.warn(`[MEME AGENT] Signal booster failed (skipped): ${err.message}`);
      return new Map();
    }
  }

   /**
    * Smart-money/KOL trade feed per token (accumulation) — analytical overlay:
    * additional candidates (strong accumulation) + cluster boost + card label.
    * Fail-open: error → empty map, screening proceeds as usual.
    */
  public async collectTrackAccumulation(chain: Chain = 'robinhood'): Promise<Map<string, TrackAccumulation>> {
    if (!this.config.trackFeedEnabled) return new Map();
    try {
      const [sm, kol] = await Promise.all([
        this.gmgn.fetchTrackTrades(chain, 'smartmoney'),
        this.gmgn.fetchTrackTrades(chain, 'kol'),
      ]);
      const acc = buildTrackAccumulation([...sm, ...kol]);
      if (acc.size > 0) console.log(`[MEME AGENT] Track feed: ${acc.size} tokens with smart-money/KOL activity.`);
      return acc;
    } catch (err: any) {
      console.warn(`[MEME AGENT] Track feed failed (skipped): ${err.message}`);
      return new Map();
    }
  }

   /**
    * Additional candidates from the track feed (BOOSTER, not a replacement):
    * tokens newly accumulated by smart money (>= minTrackWallets buying
    * wallets, total >= minTrackBuyUsd, fresh <= trackFreshMinutes) but not yet
    * appearing in rank/trenches/hot. Full data fetched via fetchTokenInfo —
    * still goes through ALL pipeline gates (graduated, preFilter, audit,
    * detect, strategy, 80).
    */
  public async collectTrackCandidates(acc: Map<string, TrackAccumulation>, chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    if (!this.config.trackFeedEnabled || acc.size === 0) return [];
    const nowSec = Date.now() / 1000;
    const out: GMGNRawToken[] = [];
    for (const a of acc.values()) {
      if (a.buyWalletCount < this.config.minTrackWallets) continue;
      if (a.totalBuyUsd < this.config.minTrackBuyUsd) continue;
      if (nowSec - a.lastBuyAt > this.config.trackFreshMinutes * 60) continue;
      try {
        const info = await this.gmgn.fetchTokenInfo(chain, a.address);
        if (info) out.push(info);
      } catch { /* this token is skipped — it does not affect the others */ }
    }
    if (out.length > 0) {
      console.log(`[MEME AGENT] New track candidates: ${out.length} tokens (smart-money accumulation, passed threshold).`);
    }
    return out;
  }

  /**
   * Fail-closed pre-filter (pure math; native price fetched once per pass).
   * Thresholds are seeded from the ACTIVE strategy's prefilter* params when
   * available (loosened presets take effect at runtime); fallback = config.
   */
  public preFilter(t: GMGNRawToken, nativePriceUsd: number | null = null): { ok: boolean; reason: string } {
    const sp = this.strategyParams ? this.strategyParams() : {};
    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
    const overrides: Partial<MemePreFilterConfig> = {
      minVolume1hUsd: num(sp.prefilterVolume1hUsd, this.config.minVolume1hUsd),
      minLiquidityUsd: num(sp.prefilterLiquidityUsd, this.config.minLiquidityUsd),
      minTotalFeeUsd: num(sp.prefilterTotalFeeUsd, this.config.minTotalFeeUsd),
      maxRugRatio: num(sp.prefilterRugRatio, this.config.maxRugRatio),
      maxRatTraderRate: num(sp.prefilterRatTraderRate, this.config.maxRatTraderRate),
      maxTop10HolderRate: num(sp.prefilterTop10HolderRate, this.config.maxTop10HolderRate),
    };
    return preFilterToken(t, { ...this.config, ...overrides }, nativePriceUsd, {
      securityGate: {
        maxRugRatio: overrides.maxRugRatio,
        maxRatTraderRate: overrides.maxRatTraderRate,
        maxTop10HolderRate: overrides.maxTop10HolderRate,
      },
    });
  }

  /** Detect signal type + deterministic confidence (0-100) */
  public detectSignal(t: GMGNRawToken): { type: 'CTO'|'REVIVAL'|'MOMENTUM'|'NONE'; confidence: number; reasons: string[] } {
    return detectMemeSignal(t);
  }

  /** Build call-card payload from real data (or 'N/A') — chain-aware labels/URLs. */
  public buildPayload(t: GMGNRawToken, confidence: number, thesis: string, trackLabel?: string, chain: Chain = 'robinhood'): CallCardPayload {
    const ageHours = t.creationTimestamp !== null ? (Date.now()/1000 - t.creationTimestamp)/3600 : null;
    const total = t.buys + t.sells;
    const txRatio = total > 0 ? `Buy ${((t.buys/total)*100).toFixed(0)}% / Sell ${((t.sells/total)*100).toFixed(0)}%` : 'N/A';
    const devStr = t.devTeamHoldRate !== null ? `${(t.devTeamHoldRate*100).toFixed(1)}%${t.creatorClose ? ' (CLOSED)' : ''}` : (t.creatorClose ? 'CLOSED' : 'N/A');
    const rugStr = t.rugRatio !== null ? `${(t.rugRatio*100).toFixed(1)}%` : 'N/A';
    const bundlerStr = t.bundlerRate !== null ? `${(t.bundlerRate*100).toFixed(1)}%` : 'N/A';
    const top10Str = t.top10HolderRate !== null ? `${(t.top10HolderRate*100).toFixed(1)}%` : 'N/A';
    const smStr = trackLabel
      ? `🧠 **Smart Money:** ${trackLabel}`
      : `🧠 **Smart Traders:** ${t.smartDegenCount} wallets (+${t.creatorClose ? 'dev closed' : 'monitoring'})`;

    // Chain-aware links: dexScreener + gmgn share per-chain slugs; GoPlus uses EVM chain ids.
    const dexSlug: Record<string, string> = { robinhood: 'robinhood', sol: 'solana', bsc: 'bsc', base: 'base', eth: 'ethereum' };
    const goplusId: Record<string, string> = { robinhood: '4663', bsc: '56', base: '8453', eth: '1' };
    const networkLabel: Record<string, string> = { robinhood: 'Robinhood', sol: 'Solana', bsc: 'BNB Chain', base: 'Base', eth: 'Ethereum' };

    return {
      domain: 'MEME_ROBINHOOD',
      title: `${t.name} (${t.symbol})`,
      symbol: t.symbol,
      contractAddress: t.address,
      network: networkLabel[chain] ?? chain,
      tokenAge: ageHours !== null ? `${ageHours.toFixed(1)}h` : 'N/A',
      priceUsd: t.priceUsd > 0 ? `$${t.priceUsd}` : 'N/A',
      marketCap: t.marketCapUsd > 0 ? `$${(t.marketCapUsd/1000).toFixed(1)}k` : 'N/A',
      liquidity: t.liquidityUsd > 0 ? `$${(t.liquidityUsd/1000).toFixed(1)}k` : 'N/A',
      // Honest card: we have no real 5m/1h volume breakdown — price-change data lives in reasons/thesis
      volume5m: 'N/A',
      volume1h: 'N/A',
      volume24h: (() => { const v = volume24hOf(t); return v > 0 ? `$${(v/1000).toFixed(1)}k` : 'N/A'; })(),
      txRatio,
      top10Pct: top10Str,
      devHoldingPct: devStr,
      sniperPct: 'N/A', // not exposed by rank; keep honest
      bundlerPct: bundlerStr,
      dexPaidStatus: t.dexscrBoostFee > 0 ? `✅ $${t.dexscrBoostFee} boost` : (t.dexscrAd ? '✅ DexScreener ad' : 'None'),
      smartMoneyInfo: smStr,
      confidenceScore: confidence,
      securityScore: rugStr,
      aiThesis: thesis,
      gmgnUrl: `https://gmgn.ai/${chain}/token/${t.address}`,
      dexScreenerUrl: `https://dexscreener.com/${dexSlug[chain] ?? chain}/${t.address}`,
      goplusUrl: goplusId[chain] ? `https://gopluslabs.io/token-security/${goplusId[chain]}/${t.address}` : undefined,
      securityAuditPassed: true, // security audit via GMGN in preFilter (rug/honeypot/tax/insider/bundler/top10)
      socialHypeScore: confidence,
      liquidityUsd: t.liquidityUsd,
      volume1hUsd: t.volume1hUsd > 0 ? t.volume1hUsd : volume24hOf(t) / 24,
    };
  }

  /** Full pass: for each configured chain → collect → prefilter (audit GMGN) → detect → voters → report */
    public async runScreeningPass(): Promise<AgentReport<RobinhoodSignal>[]> {
      console.log('[MEME AGENT] Screening pass started (GMGN OpenAPI)...');
      const reports: AgentReport<RobinhoodSignal>[] = [];
      let scanned = 0;
      let prefiltered = 0;

      // Chains from env (MULTICHAIN_CHAINS), default = the fork's full 5-chain scope.
      // Operators narrow with `MULTICHAIN_CHAINS=sol,bsc,robinhood` etc.; an empty
      // env var still yields the full scope. Provision per-chain GMGN keys (R1) before
      // enabling chains — without a key, every audit on that chain fails (Fix #5).
      const chains: Chain[] = (process.env.MULTICHAIN_CHAINS || 'sol,bsc,base,eth,robinhood')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((s): s is Chain => (['sol', 'bsc', 'base', 'eth', 'robinhood'] as string[]).includes(s));

      for (const chain of chains) {
        const nativeSymbol = chain === 'sol' ? 'SOL' : 'ETH';
        console.log(`[MEME AGENT] ── chain=${chain} ──`);

        // 0. Live native price — once per chain per pass (fee gate conversion; cached 60s)
        let nativePriceUsd: number | null = null;
        try {
          nativePriceUsd = await this.priceFeed.getPrice(nativeSymbol);
          console.log(`[MEME AGENT] ${nativeSymbol} price: ${nativePriceUsd !== null ? '$' + nativePriceUsd.toFixed(2) : 'UNAVAILABLE (fee gate will reject all)'}`);
        } catch (err: any) {
          console.warn(`[MEME AGENT] Failed to fetch ${nativeSymbol} price: ${err.message}`);
        }

        // 1. Priority flip (keyless-first): DEXPaprika/Gecko/DexScreener feed the
        // prefilter FIRST — they are keyless, budget-free, and cover all 5 chains.
        // GMGN rank/trenches/hot is merged LAST (enrichment-only surface): its
        // per-token audit/klines/smart-money (lines below) stay the enrichment
        // layer, but GMGN discovery no longer gates the funnel. GMGN remains
        // ratelimited (429) under 5-chain scope, so candidates must NOT depend on
        // it — the keyless feeds are the discovery tier, GMGN just enriches them.
        const [gmgnDiscovery, signalBoostMap, trackAcc] = await Promise.all([
          this.collectCandidates(chain),
          this.collectSignalBoostMap(chain),
          this.collectTrackAccumulation(chain),
                  ]);
                  const trackCandidates = await this.collectTrackCandidates(trackAcc, chain);
                  // Keyless discovery tier (all self-guarded, fail-open empty when off).
                  const tapeCandidates = await this.collectTapeCandidates(chain);
                  const dexscreenerCandidates = await this.collectDexscreenerCandidates(chain);
                  const dexpaprikaCandidates = await this.collectDexpaprikaCandidates(chain);
                  const geckoCandidates = await this.collectGeckoCandidates(chain);
                  const ankrCandidates = await this.collectAnkrCandidates(chain);
                  // Merge order = prefilter priority: keyless-DEX feeds first, GMGN
                  // enrichment last. By-address dedupe (no 60s cooldown).
                  const merged = new Map<string, GMGNRawToken>();
                  for (const t of [...dexpaprikaCandidates, ...geckoCandidates, ...dexscreenerCandidates, ...tapeCandidates, ...trackCandidates, ...ankrCandidates, ...gmgnDiscovery]) merged.set(t.address.toLowerCase(), t);
        const allCandidates = [...merged.values()];
        scanned += allCandidates.length;
        if (signalBoostMap.size > 0) {
          console.log(`[MEME AGENT] ${chain}: signal overlay ${signalBoostMap.size} tokens with smart-money/KOL/CTO events.`);
        }

        // Sentiment voter: ONE batch pass per chain (X search once per batch, on-chain fields otherwise)
        let sentimentMap = new Map<string, VoterOpinion>();
        if (this.voterSwarm && allCandidates.length > 0) {
          try {
            sentimentMap = await this.sentimentVoter.evaluateBatch(allCandidates);
            console.log(`[MEME AGENT] ${chain}: sentiment scored ${sentimentMap.size} candidates.`);
          } catch (err: any) {
            console.warn(`[MEME AGENT] ${chain}: sentiment batch failed (neutral votes): ${err.message}`);
          }
        }

        // 2. Pre-filter (cheap, termasuk audit GMGN) then detect
        for (const t of allCandidates) {
          // Graduated-only: reject tokens still on the bonding curve (exchange='pump')
          if (!isGraduatedToken(t)) {
            console.log(`[MEME AGENT] ⛔ ${t.symbol}: not yet graduated (bonding curve).`);
            continue;
          }

          const filter = this.preFilter(t, nativePriceUsd);
          if (!filter.ok) { console.log(`[MEME AGENT] ${filter.reason}`); continue; }
          // Security audit — GoPlus FIRST on EVM chains (keyless, no 429 wall):
          // honeypot/blacklist/tax from the on-chain service. GMGN is the fallback
          // when GoPlus has no data for the chain or the token. Solana stays GMGN
          // (GoPlus chain map is EVM-only).
          //
          // Tradeoff (documented): when GoPlus returns data and passes, GMGN's
          // /v1/token/security is SKIPPED — so GMGN-only audit signals (renounce,
          // lock, holder concentration from that endpoint) are not dual-checked
          // on EVM. Honeypot/blacklist/tax are fully covered by GoPlus; holder
          // concentration is still enforced by the prefilter (top-10 cap) and the
          // holder-concentration check in the security voter. This is the intended
          // 429-avoidance speed tradeoff — GMGN audit remains the fallback, not
          // the dual check.
          const EVM_AUDIT_CHAINS: Record<string, 'base' | 'eth' | 'bsc' | 'robinhood'> = {
            base: 'base', eth: 'eth', bsc: 'bsc', robinhood: 'robinhood',
          };
          let auditFailedReason = '';
          if (EVM_AUDIT_CHAINS[chain]) {
            const goplus = await this.goplusService.auditToken(EVM_AUDIT_CHAINS[chain], t.address);
            const goSec = goPlusAuditGate(goplus);
            if (goSec.source === 'goplus') {
              if (!goSec.ok) {
                console.log(`[MEME AGENT] ⛔ ${t.symbol}: AUDIT FAIL — GoPlus ${goSec.reasons.join(' ')}`);
                continue;
              }
            } else {
              // GoPlus had no data — GMGN fallback (single call, may be null on 429)
              const gmgnAudit = await this.gmgn.fetchTokenSecurity(chain, t.address);
              const sec = securityAuditGate(gmgnAudit);
              if (!sec.ok) {
                auditFailedReason = `GMGN ${sec.reasons.join(' ')}`;
                console.log(`[MEME AGENT] ⛔ ${t.symbol}: AUDIT FAIL — ${auditFailedReason}`);
                continue;
              }
            }
          } else {
            // Solana: GMGN only
            const gmgnAudit = await this.gmgn.fetchTokenSecurity(chain, t.address);
            const sec = securityAuditGate(gmgnAudit);
            if (!sec.ok) {
              auditFailedReason = `GMGN ${sec.reasons.join(' ')}`;
              console.log(`[MEME AGENT] ⛔ ${t.symbol}: AUDIT FAIL — ${auditFailedReason}`);
              continue;
            }
          }
          prefiltered += 1;

          let det = applySignalBoost(this.detectSignal(t), signalBoostMap, t.address);
          // Smart-money cluster (>= 3 wallets buying the same token, fresh) = boost +20
          const trackEntry = trackAcc.get(t.address.toLowerCase());
          const trackLabel = trackEntry ? trackAccumulationLabel(trackEntry) : undefined;
          if (trackEntry && trackEntry.buyWalletCount >= 3 && det.type !== 'NONE') {
            det = {
              ...det,
              confidence: Math.min(100, det.confidence + 20),
              reasons: [...det.reasons, `⚡ Cluster of ${trackEntry.buyWalletCount} smart-money wallets bought $${(trackEntry.totalBuyUsd / 1000).toFixed(0)}k (+20)`],
            };
          }
          if (det.type === 'NONE' || det.confidence < this.config.passThreshold) {
            console.log(`[MEME AGENT] ⚪ ${t.symbol}: ${det.type} ${det.confidence}% < ${this.config.passThreshold}% (${det.reasons.join(' | ')})`);
            continue;
          }

          // ML predictor input: 15m klines (only when the candidate is close to conviction — saves GMGN budget)
          let klines: KlineCandle[] | null = null;
          if (this.voterSwarm && det.confidence >= 60) {
            // GMGN-primary → GeckoTerminal fallback (pool resolved via token address).
            klines = await fetchKlinesWithGeckoFallback(
              () => this.gmgn.fetchTokenKlines(chain, t.address, '15m', 50),
              geckoNetworkIdFor(chain),
              t.address
            ) as KlineCandle[] | null;
          }

          // Strategy extension layer (optional): adjust confidence
          let confidence = det.confidence;
          let strategyReason = '';
          try {
            const strat = this.strategyEngine.getActiveStrategy('meme-robinhood');
            if (strat?.evaluate) {
              const ev = this.strategyEngine.runStrategySafely(strat, 'evaluate', {
                domain: 'MEME_ROBINHOOD', symbol: t.symbol, contractAddress: t.address,
                priceUsd: t.priceUsd, liquidityUsd: t.liquidityUsd,
                volume24hUsd: volume24hOf(t), volume1hUsd: t.volume1hUsd > 0 ? t.volume1hUsd : volume24hOf(t)/24,
                smartMoneyCount: t.smartDegenCount, securityAuditPassed: true,
                socialHypeScore: confidence,
                gmgn: { ...toStrategyGmgn(t), native_price_usd: nativePriceUsd },
              });
              if (ev?.recommendedAction === 'SKIP') {
                console.log(`[MEME AGENT] ⛔ ${t.symbol}: strategy rejected (${ev.reason})`);
                continue;
              }
              if (ev && typeof ev.confidence === 'number') {
                confidence = Math.round(confidence * 0.7 + Math.max(0, Math.min(100, ev.confidence)) * 0.3);
                strategyReason = ev.reason || '';
              }
            }
          } catch (err: any) { console.warn(`[MEME AGENT] Strategy failed: ${err.message}`); }

          // Fail-closed: the 80 gate must hold on the FINAL blended confidence
          if (confidence < this.config.passThreshold) {
            console.log(`[MEME AGENT] ⚪ ${t.symbol}: ${det.type} ${confidence}% < ${this.config.passThreshold}% (post-strategy)`);
            continue;
          }

          const thesis = buildMemeThesis(t, det.type, confidence, det.reasons, strategyReason);
          const payload = this.buildPayload(t, confidence, thesis, trackLabel, chain);

          // Arch-3 voter swarm: assemble opinions for this FINALIST and attach them to the
          // payload — the consensus gate in index.ts re-derives confidence from the weighted
          // average, so the swarm (not the agent) has the final word.
          if (this.voterSwarm) {
            // Kernel A reputation read-path: active only when a deployer address is
            // available; otherwise the plain fail-closed voters run unchanged.
            const repCtx = reputationContextFromToken(globalReputationMemory, t);
            // Security vote: carry elevated-but-passing indicators so the 0.25-weight
            // security voter isn't a constant 100 for finalists (still fail-closed 0 on
            // audit failure — that's rejected before we get here).
            const securityPenalties: string[] = [];
            if (t.rugRatio !== null && t.rugRatio > 0.15) securityPenalties.push('elevated rug risk');
            if (t.top10HolderRate !== null && t.top10HolderRate > 0.3) securityPenalties.push('holder concentration');
            if (t.creatorClose) securityPenalties.push('dev closed');
            // Bot-detection (WWW'26) + rug-feature (early-window) materialized
            // into the safety voters. Fail-open: no fields → neutral 0 risk.
            const botReport = globalBotDetection.analyze(t);
            recordBotRiskSample(botReport.botRisk);
            if (botReport.needsBotKillSwitch) {
              securityPenalties.push(`CRITICAL bot risk ${botReport.botRisk} — ${botReport.reasons[botReport.reasons.length - 1]}`);
            } else if (botReport.botRisk >= 40) {
              securityPenalties.push(`bot risk ${botReport.botRisk} (${botReport.signals.bundle ? 'bundle' : ''}${botReport.signals.sniper ? '+sniper' : ''}${botReport.signals.gradualBundle ? '+gradual' : ''})`);
            }
            const rugFeature = globalRugScoring.assess(t);
            securityPenalties.push(...rugFeature.penalties);
            if (typeof t.bytecode === 'string') {
              const scan = this.bytecodeScanner.scan(t.bytecode);
              securityPenalties.push(...scan.findings);
            } else if (EVM_AUDIT_CHAINS[chain]) {
              // No hex from GMGN (enrichment 429/absent) — fetch deployed code
              // from the RPC pool (keyless, fail-soft) and scan it. Extra leg,
              // never a gate: transport errors return an empty scan.
              const scan = await this.bytecodeScanner.scanContract(chain, t.address);
              securityPenalties.push(...scan.findings);
            }
            const sellCheck = await this.sellability.check(t.sellTrade ?? { liquidityUsd: t.liquidityUsd });
            if (!sellCheck.sellable) securityPenalties.push(...sellCheck.reasons);
            // #3 deterministic anti-fooling: cross-source contradictions the
            // heuristics wouldn't flag alone (sellability contradiction, launch-
            // bundle forensics, honeypot deny-list). fooled → hard security demerit.
            const fooling = antiFoolingRisk(t, {
              sellable: sellCheck.sellable,
              sellReasons: sellCheck.reasons,
              claimedLiquidityUsd: t.liquidityUsd ?? undefined,
            });
            securityPenalties.push(...antiFoolingPenalties(fooling));
            const baseCtx: VoterContext = {
              token: t,
              chain,
              nativePriceUsd: (t as any).nativePrice ?? 0,
              securityAuditPassed: botReport.botRisk < 70 && securityPenalties.length === 0,
              signalConfidence: confidence,
            };
            const opinions: VoterOpinion[] = [
              repCtx
                ? reputationAwareSecurityVote(true, repCtx.memory, t.address, repCtx.deployer, repCtx.snapshot, securityPenalties, botReport.botRisk)
                : securityVote(true, securityPenalties, botReport.botRisk),
              await stickyQuantVote(globalDecisionCache, confidence, {
                key: `${t.address.toLowerCase()}:${det.type}`,
                reasons: [`detected ${det.type} (post-strategy ${confidence}%)`],
                priceMovePct: 10,
                price: (t as any).nativePrice ?? 0,
              }),
            ];
            // Q03 wallet-score voter — feeds the wallet/concentration/dev dimension.
            // Fail-open neutral when the runtime can't compute the wallet score; the existing
            // security vote still enforces hard penalties above.
            opinions.push(
              repCtx
                ? reputationAwareWalletVote({ ...baseCtx, walletMetrics: (t as any).walletMetrics, reputation: repCtx })
                : walletVote({ ...baseCtx, walletMetrics: (t as any).walletMetrics }),
            );
            // Q05 flow-convergence voter — neutral when the agent didn't accumulate any buy flow.
            // Kernel F owner-dedup: one actor's N wallets count as one confirmation.
            // I0-1: hydrate convergence from the Blockscout feed (env-gated) for
            // this finalist only — the voter stops being permanently neutral.
            if (this.blockscout && blockscoutFeedEnabled()) {
              const chainId = chainIdFor(chain);
              if (chainId !== undefined && !(t as any).convergence) {
                const buys = await this.blockscout.getBuyEvents(chainId, t.address);
                if (buys.length > 0) (t as any).convergence = { buys };
              }
            }
            opinions.push(await ownerDedupedConvergenceVote(globalDecisionCache, { ...baseCtx, convergence: (t as any).convergence }));
            // Q12 risk-rubric voter (portable rubric) — neutral when no rubric metrics present.
            opinions.push(rubricVote({ ...baseCtx, rubricMetrics: (t as any).rubricMetrics }));
            const sent = sentimentMap.get(t.address.toLowerCase());
            if (sent) {
              // I2-1: sentiment is a veto/tiebreak, not an additive vote that must
              // cross the 80% floor. A contradiction (paid hype / strong mentions
              // with NO on-chain buy flow) is a hard demerit — sentiment cannot
              // independently lift a candidate over the security/liquidity gates.
              const s = sent as { contradiction?: boolean };
              if (s.contradiction) {
                opinions.push({ ...sent, score: Math.max(0, Math.min(100, sent.score - 30)), reasons: [...sent.reasons, 'sentiment contradiction veto'] });
              } else {
                // Tiebreak only: strong organic sentiment breaks close calls but
                // never independently lifts a weak candidate into PASS.
                opinions.push(sent);
              }
            }
            const trk = trackAcc.get(t.address.toLowerCase());
            const trackTrades: VoterContext['trackTrades'] = [];
            if (trk) {
              if (trk.totalBuyUsd > 0) trackTrades.push({ side: 'buy', amountUsd: trk.totalBuyUsd, isFullClose: false });
              const partialSell = trk.totalSellUsd - trk.fullCloseTotalUsd;
              if (partialSell > 0) trackTrades.push({ side: 'sell', amountUsd: partialSell, isFullClose: false });
              if (trk.fullCloseTotalUsd > 0) trackTrades.push({ side: 'sell', amountUsd: trk.fullCloseTotalUsd, isFullClose: true });
            }
            opinions.push(whaleVote(trackTrades, botReport.botRisk));
            if (klines) {
              const pred = predictUpMomentum(klines);
              opinions.push({ voter: 'ml', score: pred.score, reasons: pred.reasons });
            } else {
              opinions.push({ voter: 'ml', score: 50, reasons: ['no klines — neutral vote'] });
            }
            if (this.criticVoter) {
              try {
                opinions.push(await this.criticVoter.evaluate({ token: t, chain, thesis, reasons: det.reasons }));
              } catch (err: any) {
                console.warn(`[MEME AGENT] Critic failed (neutral): ${err.message}`);
                opinions.push({ voter: 'critic', score: 50, reasons: ['critic error — neutral'] });
              }
            }
            payload.voterScores = consolidateOpinions(opinions);
          }

          const signal: RobinhoodSignal = { token: t, signalType: det.type, confidence, reasons: det.reasons };
          reports.push({ passed: true, signal, reason: thesis, confidence, payload });
          console.log(`[MEME AGENT] 🎯 ${det.type} ${t.symbol} ${confidence}% (${chain})`);
        }
      }

      console.log(`[MEME AGENT] Pass complete. ${reports.length} signals passed.`);
      this.lastFunnel = { scanned, prefiltered, emitted: reports.length };
      console.log(`[FUNNEL] meme chains=${chains.join('+')} scanned=${scanned} prefiltered=${prefiltered} emitted=${reports.length}`);
      return reports;
      }

      /** Phase-1 funnel stats from the most recent pass (index.ts [FUNNEL] counters). */
      public getLastFunnelStats(): { scanned: number; prefiltered: number; emitted: number } {
      return { ...this.lastFunnel };
      }

  /** Map GMGNRawToken -> snake_case GMGN field contract consumed by strategy .mjs modules */
  public toStrategyGmgn(t: GMGNRawToken): Record<string, unknown> {
    return toStrategyGmgn(t);
  }
}
