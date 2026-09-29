import { GMGNAdapter, GMGNRawToken, type Chain, type KlineCandle } from '../../adapters/gmgn-adapter.js';
import { RhFillTapeReader } from '../../adapters/rh-fill-tape.js';
import { chainIdFor, type MarketDataProvider } from '../../adapters/market-data-provider.js';
import { globalPriceFeedService } from '../../services/price-feed-service.js';
import { globalBotDetection, recordBotRiskSample } from '../../services/bot-detection.js';
import { globalRugScoring } from '../../services/rug-scoring.js';
import { antiFoolingRisk, antiFoolingPenalties } from '../../services/anti-fooling.js';
import { globalFreshPairWatchlist } from '../../services/fresh-pair-watchlist.js';
import { BytecodeScanner } from '../../services/bytecode-scanner.js';
import { SellabilitySimulator } from '../../services/sellability/sellability-simulator.js';
import { StrategyEngine } from '../../orchestrator/strategy-engine.js';
import { capSignalConfidence } from '../../orchestrator/swarm-guards.js';
import { assessSolanaTimeOnCurve } from '../../services/copy-trade-hesitation.js';
import type { TimeOnCurveAssessOptions } from '../../services/time-on-curve.js';
import { buildFeatureSnapshot } from '../../features/feature-snapshot.js';
import { globalCandidateRegistry, isIntroducerEnabled } from '../../discovery/discovery-registry.js';
import { DiscoveryCoordinator, type CandidateEmitter } from '../../discovery/candidate-emitter.js';
import { sourceParticipation } from '../../startup/provider-banner.js';
import { FomoApiClient, type FomoChain } from '../../adapters/fomo-api.js';
import { FomoTokenBoardProvider } from '../../adapters/fomo-emitter.js';
import { globalTraderPersistence, walletNativeCohorts } from '../../services/onchain/trader-persistence.js';
import { globalWalletGraph } from '../../services/onchain/wallet-graph.js';
import { DeFiLlamaRegimeFeed, type RegimeSnapshot } from '../../adapters/defillama-feed.js';
import { ArkhamEnrich, type ArkhamEntity } from '../../adapters/arkham-enrich.js';
import { globalPersistenceCohort } from '../../graph/persistence-cohort.js';
import { JevRouter, type JevClient } from '../../ai/jev-router.js';
import { calibratedDecision } from '../../features/calibrated-decision.js';
import type { ScreeningAgent, AgentReport, CallCardPayload } from '../shared/agent-contract.js';
import { GoPlusSecurityService } from '../../services/goplus-security-service.js';
import { CoinStatsRiskService } from '../../services/coinstats-risk.js';
import { BlockscoutFeed, blockscoutFeedEnabled } from '../../adapters/blockscout-feed.js';
import { JsonRpcWsTape } from '../../adapters/jsonrpc-ws-tape.js';
import { RpcVerify } from '../../services/onchain/rpc-verify.js';
import { globalSourceQuota, classifyHttpFailure, statusOf } from '../../services/source-quota.js';
import type { BuyEvent } from '../../services/flow-convergence.js';
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
  /** Routescan keyless multi-chain explorer feed (new-token discovery + holders). Empty until injected. */
  private routescan: MarketDataProvider | null;
  /** P3.6 injectable Solana signature loader (getSignaturesForAddress walk). */
  private solTimeOnCurveLoader: TimeOnCurveAssessOptions['loader'] | null;
  /** P4.1 CMC keyless DEX feed (new-pair walking + holders). Empty until injected. */
  private cmcDex: MarketDataProvider | null;
  /** Solana RPC INTRODUCER feed (generic SPL-create walk over the Sol RPC failover). Empty until injected. */
  private solanaRpc: MarketDataProvider | null;
  /** SolanaTracker Sol ENRICHER feed (price/overview/stats/risk via free Data API). Empty until injected. */
  private solanatracker: MarketDataProvider | null;
  /** P0.1 FOMO API candidate-emitter feed (token boards, trader intel). Empty until injected. */
  private fomo: FomoTokenBoardProvider | null;
  private fomoClient: FomoApiClient | null;
  /**
   * Strategic move — own-tape discovery: Sol JsonRpcWsTape(s) whose pump.fun
   * `programSubscribe` mint events are drained as a pre-graduation introducer
   * (footprint over raw Sol WS, same signal PumpDev streams, no key/credits).
   * Injected after startup (tapes are wired after the agent is constructed).
   */
  private jsonRpcWsTapes: JsonRpcWsTape[];
  /**
   * Phase 3 — DiscoveryCoordinator: owns candidate-merge priority, allowlist +
   * cooldown, and fail-soft across all discovery emitters so the agent stops
   * knowing how each provider works. Built in the constructor from this agent's
   * feeds; tape/track (dynamic per-pass state) are supplied as `extras`.
   */
  private discoveryCoordinator: DiscoveryCoordinator;
  /** P1.5 DeFiLlama regime feed (regime CONTEXT, not a token-score voter). Empty until injected. */
  private defillama: DeFiLlamaRegimeFeed | null;
  /** P1.4 Arkham entity enricher (entity/deployer/label resolution on finalists). Empty until injected. */
  private arkham: ArkhamEnrich | null;
  /** Kernel D deterministic bytecode scan for EVM tokens that carry hex. */
  private bytecodeScanner: BytecodeScanner;
  /** Kernel D round-trip sell proof, fail-closed until a pass is proven. */
  private sellability: SellabilitySimulator;
  /** P4.2 CoinStats token-risks (finalist security second-read, EVM only). */
  private coinstatsRisk: CoinStatsRiskService | null;
  /** P5.2 Jev shadow-mode router (never gates; swarm fallback). */
  private jevRouter: JevRouter | null;
  /** Keyless EVM token-security audit (GoPlus) — primary before GMGN. */
  private goplusService: GoPlusSecurityService;
  /** I0-1 Blockscout BuyEvent producer for the convergence voter (env-gated). */
  private blockscout: BlockscoutFeed | null;
  /**
   * Strategic move — independent on-chain verify over the failover pool
   * (eth_getTransactionReceipt). The second verify source vs Blockscout.
   */
  private rpcVerify: RpcVerify;

  /** Last pass funnel stats — consumed by index.ts for the Phase-1 [FUNNEL] counters. */
  private lastFunnel: { scanned: number; prefiltered: number; emitted: number } = { scanned: 0, prefiltered: 0, emitted: 0 };
  /** Prefilter rejection buckets for the CURRENT pass. Diagnostic only —
   *  counters which of the fail-closed floors is actually binding, so an
   *  operator can tell a $50k volume bar from a dead feed without reading
   *  every token's rejection line. Reset each pass; never gates anything. */
  private prefilterRejections = new Map<string, number>();

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
      routescan?: MarketDataProvider | null;
      solTimeOnCurveLoader?: TimeOnCurveAssessOptions['loader'] | null;
      cmcDex?: MarketDataProvider | null;
      solanaRpc?: MarketDataProvider | null;
      solanatracker?: MarketDataProvider | null;
      fomo?: FomoTokenBoardProvider | null;
      defillama?: DeFiLlamaRegimeFeed | null;
      arkham?: ArkhamEnrich | null;
      bytecodeScanner?: BytecodeScanner;
      sellability?: SellabilitySimulator;
      blockscout?: BlockscoutFeed | null;
      jsonRpcWsTapes?: JsonRpcWsTape[];
      rpcVerify?: RpcVerify;
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
    this.routescan = opts.routescan ?? null;
    this.solTimeOnCurveLoader = opts.solTimeOnCurveLoader ?? null;
    this.cmcDex = opts.cmcDex ?? null;
    this.solanaRpc = opts.solanaRpc ?? null;
    this.solanatracker = opts.solanatracker ?? null;
    this.fomo = opts.fomo ?? null;
    this.fomoClient = this.fomo
      ? new FomoApiClient({ apiKey: process.env.FOMO_API_KEY ?? '' })
      : null;
    this.jsonRpcWsTapes = opts.jsonRpcWsTapes ?? [];
    this.defillama = opts.defillama ?? null;
    this.arkham = opts.arkham ?? null;
    this.bytecodeScanner = opts.bytecodeScanner ?? new BytecodeScanner();
    this.sellability = opts.sellability ?? new SellabilitySimulator(() => ({ simulated: false, sellable: false }));
    this.goplusService = new GoPlusSecurityService();
    this.coinstatsRisk = process.env.COINSTATS_API_KEY ? new CoinStatsRiskService() : null;
    this.jevRouter = this.buildJevRouter();
    this.blockscout = opts.blockscout ?? null;
    this.rpcVerify = opts.rpcVerify ?? new RpcVerify();
    this.discoveryCoordinator = this.buildDiscoveryCoordinator();
  }

  /**
   * Phase 3 — build the DiscoveryCoordinator from this agent's feeds. Provider
   * feeds + fomo + WS-tape register as named emitters; tape/track (dynamic
   * per-pass state) are supplied to discoverAll as `extras`.
   */
  private buildDiscoveryCoordinator(): DiscoveryCoordinator {
    const c = new DiscoveryCoordinator();
    // Each emitter delegates to the agent's collect method, which self-gates
    // its own enable env-var + DISCOVERY_INTRODUCERS allowlist + cooldown.
    // enabled() is `true` so the coordinator never bypasses a spied/mocked
    // method — the method (or its mock) decides.
    const reg = (id: string, discover: (chain: Chain) => Promise<GMGNRawToken[]>, allowlistSource?: string) =>
      c.add({ id, allowlistSource, enabled: () => true, discover });
    reg('dexscreener', (ch) => this.collectDexscreenerCandidates(ch));
    reg('dexpaprika', (ch) => this.collectDexpaprikaCandidates(ch));
    reg('gecko', (ch) => this.collectGeckoCandidates(ch));
    reg('ankr', (ch) => this.collectAnkrCandidates(ch));
    reg('routescan', (ch) => this.collectRoutescanCandidates(ch));
    reg('cmc', (ch) => this.collectCmcDexCandidates(ch));
    reg('solana-rpc', (ch) => this.collectSolanaRpcCandidates(ch));
    reg('solanatracker', (ch) => this.collectSolanaTrackerCandidates(ch));
    reg('fomo', (ch) => this.collectFomoCandidates(ch));
    // WS-tape pump.fun mints promote under the solana-rpc introducer.
    reg('ws-tape', (ch) => this.collectJsonRpcWsTapeCandidates(ch), 'solana-rpc');
    return c;
  }

  /**
   * P5.2: build the Jev router. Client only when JEV_API_BASE is set; the
   * router itself is inert unless JEV_ENABLED=true (shadow mode).
   */
  private buildJevRouter(): JevRouter | null {
    const apiBase = process.env.JEV_API_BASE;
    const apiKey = process.env.JEV_API_KEY;
    const client: JevClient | undefined = apiBase
      ? {
          call: async (state: unknown) => {
            const res = await fetch(`${apiBase.replace(/\/$/, '')}/decide`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
              body: JSON.stringify({ state }),
            });
            if (!res.ok) throw new Error(`jev HTTP ${res.status}`);
            return (await res.json()) as import('../../ai/jev-schema.js').JevOutput;
          },
        }
      : undefined;
    return new JevRouter({ swarmConfidence: this.config.passThreshold ?? 80, client });
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

  /** Routescan multi-chain new-token discovery. Guarded by ROUTESCAN_FEED_ENABLED=true. */
  public async collectRoutescanCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    return this.collectProviderCandidates(this.routescan, 'routescan', 'ROUTESCAN_FEED_ENABLED', chain);
  }

  /** CMC keyless DEX new-pair discovery. Guarded by CMC_DEX_FEED_ENABLED=true. */
  public async collectCmcDexCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    return this.collectProviderCandidates(this.cmcDex, 'cmc', 'CMC_DEX_FEED_ENABLED', chain);
  }

  /** Solana RPC INTRODUCER (generic SPL-create walk over the Sol RPC failover).
   *  Guarded by SOLANA_RPC_FEED_ENABLED=true + SOLANA_RPC_URL and the
   *  DISCOVERY_INTRODUCERS list. */
  public async collectSolanaRpcCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    return this.collectProviderCandidates(this.solanaRpc, 'solana-rpc', 'SOLANA_RPC_FEED_ENABLED', chain);
  }

  /**
   * Strategic move — own-tape discovery injection. The JsonRpcWsTape(s) are
   * wired AFTER the agent is constructed (index.ts), so this is how those Sol
   * WS tape housings reach the screening pass.
   */
  public injectJsonRpcWsTapes(tapes: JsonRpcWsTape[]): void {
    this.jsonRpcWsTapes = tapes;
  }

  /**
   * Drain the injected Sol WS tapes' `recentEvents()` as a pre-graduation
   * pump.fun introducer (mint pubkeys from `programSubscribe`). Guarded by
   * JSONRPC_WS_TAPE_ENABLED=true + DISCOVERY_INTRODUCERS allowlist. Fail-open:
   * empty. Duplicate mints within a drain are collapsed (same keyless feed
   * surface as pumpdev/solana-rpc, so the by-address merge dedupes too).
   */
  public async collectJsonRpcWsTapeCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    if (chain !== 'sol') return [];
    if (process.env.JSONRPC_WS_TAPE_ENABLED !== 'true') return [];
    if (!isIntroducerEnabled('solana-rpc', process.env.DISCOVERY_INTRODUCERS)) return [];
    if (this.jsonRpcWsTapes.length === 0) return [];
    try {
      const seen = new Set<string>();
      const out: GMGNRawToken[] = [];
      for (const tape of this.jsonRpcWsTapes) {
        for (const evt of tape.recentEvents(100)) {
          if (evt.chain !== 'sol') continue;
          const mint = evt.id;
          if (!mint || seen.has(mint)) continue;
          seen.add(mint);
          out.push(
            normalizeDexToken(
              chain,
              { address: mint, chainId: 0, symbol: '', priceUsd: 0, liquidityUsd: 0, volume24hUsd: 0 },
              'solana-rpc',
            ),
          );
        }
      }
      if (out.length > 0) console.log(`[MEME AGENT] WS-tape discovery: ${out.length} pump.fun mints from own Sol WS tapes.`);
      return out;
    } catch (err: any) {
      console.warn(`[MEME AGENT] WS-tape candidates failed (skipped): ${err.message}`);
      return [];
    }
  }

  /**
   * Strategic move — second, independent verify signal. Blockscout reports buy
   * events from its INDEXED view; this confirms the latest buy transaction
   * directly on-chain via eth_getTransactionReceipt over the failover pool.
   * Returns null when the chain has no RPC verify lane or the tx is unconfirmable
   * (fail-soft → "no independent confirmation", never a false confirmation).
   */
  private async rpcVerifyCrossCheck(chain: Chain, buys: BuyEvent[]): Promise<{ confirmed: boolean; txHash?: string; status?: boolean } | null> {
    const rpcKey = chain === 'eth' ? 'eth' : chain === 'base' ? 'base' : chain === 'bsc' ? 'bsc' : chain === 'robinhood' ? 'rh' : undefined;
    if (!rpcKey) return null;
    const tx = buys.find((b) => b.txHash);
    if (!tx?.txHash) return null;
    const receipt = await this.rpcVerify.getTransactionReceipt(rpcKey, tx.txHash);
    if (!receipt) return null;
    return { confirmed: receipt.confirmed, txHash: receipt.txHash, status: receipt.status };
  }

  /** SolanaTracker Sol ENRICHER (price/overview/stats via free Data API).
   *  Guarded by SOLANATRACKER_FEED_ENABLED=true + SOLANATRACKER_API_KEY; Sol-only,
   *  so it yields nothing on non-Sol chains (filtered inside the feed). */
  public async collectSolanaTrackerCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    return this.collectProviderCandidates(this.solanatracker, 'solanatracker', 'SOLANATRACKER_FEED_ENABLED', chain);
  }

  /**
   * P0.1 FOMO API candidate-emitter feed (token boards). Guarded by
   * FOMO_FEED_ENABLED=true && the injected fomo provider.
   */
  public async collectFomoCandidates(chain: Chain = 'robinhood'): Promise<GMGNRawToken[]> {
    if (process.env.FOMO_FEED_ENABLED !== 'true') return [];
    if (!this.fomo) return [];
    if (!isIntroducerEnabled('fomo', process.env.DISCOVERY_INTRODUCERS)) return [];
    try {
      const chainId = chainIdFor(chain);
      const tokens = await this.fomo.discover({ chainIds: chainId !== undefined ? [chainId] : [] });
      return tokens.map((t) => normalizeDexToken(chain, t, 'fomo'));
    } catch (err: any) {
      console.warn(`[MEME AGENT] fomo candidates failed (skipped): ${err.message}`);
      return [];
    }
  }

  /**
   * P0.4 FOMO trader intelligence: ingest the 24h/7d/30d leaderboards into the
   * TraderPersistence intersection and seed the WalletGraph from resolved
   * identities. This is the durable moat — the persistent-trader cohort that
   * front-runs again. Guarded by FOMO_FEED_ENABLED=true. Fail-open: no-op.
   */
  public async collectFomoTraderIntel(chain: Chain = 'robinhood'): Promise<void> {
    if (process.env.FOMO_FEED_ENABLED !== 'true') return;
    if (!this.fomoClient) return;
    try {
      const fomoChain = chain === 'sol' ? 'solana' : chain === 'eth' ? 'ethereum' : (chain as FomoChain);
      const windows = ['24h', '7d', '30d'] as const;
      await Promise.all(
        windows.map(async (w) => {
          const rows = await this.fomoClient!.leaderboard(w, fomoChain, 50);
          for (let i = 0; i < rows.length; i++) {
            const r = rows[i]!;
            globalTraderPersistence.ingest({
              handle: r.handle,
              window: w,
              pnlPct: r.pnlPct,
              volumeUsd: r.volumeUsd,
              solWallet: r.solWallet,
              evmWallet: r.evmWallet,
              chain: r.chain,
              provider: 'fomo',
              rank: i + 1,
              // P0 time-current: stamp the board fetch so stale windows decay.
              fetchedAt: Date.now(),
            });
            // Phase 4 — trader identity graph: register handle→wallet identity
            // (provider + chain attributed). Same handle across chains/wallets
            // collapses into one canonical actor; handled likewise.
            globalWalletGraph.registerHandle(r.handle, {
              chain: r.chain,
              provider: 'fomo',
              wallets: [r.solWallet, r.evmWallet].filter((x): x is string => !!x),
            });
          }
        }),
      );
      const s = globalTraderPersistence.stats();
      if (s.persistent > 0) {
        const cohorts = walletNativeCohorts(globalTraderPersistence, globalWalletGraph);
        let collapsed = 0;
        for (const c of cohorts) if (c.collapsedTraders > 1) collapsed += 1;
        console.log(
          `[MEME AGENT] FOMO trader intel: ${s.handles} handles, ${s.persistent} persistent (24h∩7d∩30d), ${cohorts.length} wallet-native cohorts (${collapsed} collapsed clusters).`,
        );
      }
    } catch (err: any) {
      console.warn(`[MEME AGENT] FOMO trader intel failed (skipped): ${err.message}`);
    }
  }

  /**
   * P1.5 DeFiLlama REGIME CONTEXT (explicitly NOT a token-score voter). Read
   * once per chain per pass (hourly-cached upstream). Fail-open: neutral regime.
   * Used only as context on the [REGIME] line — it never gates or re-scores.
   */
  public async collectRegimeContext(chain: Chain = 'robinhood'): Promise<RegimeSnapshot | null> {
    if (process.env.DEFILLAMA_FEED_ENABLED !== 'true') return null;
    if (!this.defillama) return null;
    try {
      const chainName = chain === 'sol' ? 'solana' : chain === 'eth' ? 'ethereum' : chain === 'bsc' ? 'bsc' : chain === 'base' ? 'base' : 'robinhood';
      const regime = await this.defillama.regime({ chainName });
      if (regime.healthy) {
        console.log(
          `[REGIME] ${chain} TVL=$${(regime.tvlUsd / 1e6).toFixed(1)}M 24hΔ=${regime.change24hPct.toFixed(2)}% top=${regime.topChains.slice(0, 3).map((c) => c.name).join(',')}`,
        );
      }
      return regime;
    } catch (err: any) {
      console.warn(`[MEME AGENT] DeFiLlama regime failed (skipped): ${err.message}`);
      return null;
    }
  }

  /**
   * P1.4 Arkham ENTITY enrichment for a finalist (entity/deployer/label). Gated
   * by ARKHAM_ENABLED + injected client. Fail-open: returns null on any error;
   * NEVER gates — the entity is informational/overlay (second-opinion #10).
   *
   * Resolves the DEPLOYER/CREATOR wallet when the token carries one (that is the
   * meaningful entity — deployer reputation, known-scam clusters, exchange
   * labels); falls back to the token address only when no deployer is present.
   */
  public async enrichFinalistEntity(t: GMGNRawToken): Promise<ArkhamEntity | null> {
    if (process.env.ARKHAM_ENABLED !== 'true') return null;
    if (!this.arkham) return null;
    try {
      const subject = typeof t.deployer === 'string' && t.deployer.trim() ? t.deployer.trim() : t.address;
      return await this.arkham.entity(subject);
    } catch (err: any) {
      console.warn(`[MEME AGENT] Arkham entity failed (skipped): ${err.message}`);
      return null;
    }
  }

  /**
   * Shared keyless-feed collector. Fails open (empty) unless the env gate is on
   * and a provider is injected. Normalizes discovered MarketTokens (filtered to
   * the current chain) into GMGNRawToken tagged with the source name.
   */
  private async collectProviderCandidates(
    provider: MarketDataProvider | null,
    source: 'gmgn' | 'dexscreener' | 'dexpaprika' | 'gecko' | 'ankr' | 'routescan' | 'cmc' | 'solana-rpc' | 'fomo' | 'solanatracker',
    envVar: string,
    chain: Chain = 'robinhood',
  ): Promise<GMGNRawToken[]> {
    if (process.env[envVar] !== 'true') return [];
    if (!provider) return [];
    // DISCOVERY_INTRODUCERS allowlist gate (unset → every enabled feed participates).
    if (!isIntroducerEnabled(source, process.env.DISCOVERY_INTRODUCERS)) return [];
    // Best-effort demotion: a source in cooldown is short-circuited (no hammering,
    // no repeated logs) instead of blocking the funnel.
    if (globalSourceQuota.isCooling(source)) return [];
    try {
      const chainId = chainIdFor(chain);
      const tokens = await provider.discover({ chainIds: chainId !== undefined ? [chainId] : [] });
      return tokens.map((t) => normalizeDexToken(chain, t, source));
    } catch (err: any) {
      // Classify (400/402/429 → quota cooldown) and log only on the first hit
      // in the window, so an indexer outage degrades silently.
      const cls = classifyHttpFailure(statusOf(err), err);
      if (globalSourceQuota.backoff(source, cls)) {
        console.warn(`[MEME AGENT] ${source} candidates failed (skipped) [${cls}]: ${err?.message ?? err}`);
      }
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

  /**
   * Batch-fetch real market data for fresh-pair addresses from DexScreener
   * /latest/dex/tokens/{addresses} (up to 30 comma-separated per call — the
   * endpoint's documented batch limit). Fail-soft per batch: a failed call
   * leaves that slice unenriched (null) so fresh pairs keep their zeros and
   * the volume-ranked feeds re-surface them later. Keyless.
   */
  /**
   * Real observed volume for fresh pairs. DexScreener gives 24h only; DEXPaprika's
   * per-token detail gives REAL 1h/15m/5m USD volume. PR7 wiring: when the
   * dexpaprika feed is injected, use its tokenDetail() to override the 24h/24
   * estimate on fresh-loop hot addresses (budget-capped at 8/call — keyless
   * DEXPaprika is 15 req/min).
   */
  private async overlayDexpaprikaVolume(
    out: Map<string, { priceUsd?: number; liquidityUsd?: number; volume24hUsd?: number; volume1hUsd?: number; symbol?: string; buyUsd1h?: number; sellUsd1h?: number }>,
    chain: string,
    addresses: string[],
  ): Promise<void> {
    if (!this.dexpaprika?.tokenDetail) return;
    let used = 0;
    const MAX_DETAIL_CALLS = 8;
    for (const addr of addresses) {
      if (used >= MAX_DETAIL_CALLS) break;
      try {
        const detail = await this.dexpaprika.tokenDetail(chain, addr);
        used += 1;
        if (!detail) continue;
        const key = addr.toLowerCase();
        const prev = out.get(key) ?? {};
        out.set(key, {
          ...prev,
          // REAL observed 1h volume — replaces the volume24h/24 estimate the
          // prefilter would otherwise see (the I1-4 feed-vs-zero fix).
          ...(detail.volume1hUsd !== undefined ? { volume1hUsd: detail.volume1hUsd } : {}),
          // Real 1h buy/sell USD — lets the strategy use USD flow, not count
          // ratio (audit finding: counts lie on size-differential flows).
          ...(detail.buyUsd1h !== undefined ? { buyUsd1h: detail.buyUsd1h } : {}),
          ...(detail.sellUsd1h !== undefined ? { sellUsd1h: detail.sellUsd1h } : {}),
        });
      } catch {
        // fail-soft: keep the estimate; never block the fresh lane
      }
    }
  }

  private async batchFreshMarketData(
    addresses: string[],
    chain: string,
  ): Promise<Map<string, { priceUsd?: number; liquidityUsd?: number; volume24hUsd?: number; volume1hUsd?: number; symbol?: string; buyUsd1h?: number; sellUsd1h?: number }>> {
    const out = new Map<string, { priceUsd?: number; liquidityUsd?: number; volume24hUsd?: number; volume1hUsd?: number; symbol?: string; buyUsd1h?: number; sellUsd1h?: number }>();
    const uniq = [...new Set(addresses.map((a) => a.toLowerCase()).filter(Boolean))];
    const BATCH = 30;
    for (let s = 0; s < uniq.length; s += BATCH) {
      const slice = uniq.slice(s, s + BATCH);
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${slice.join(',')}`);
        if (!res.ok) continue;
        const body = (await res.json()) as { pairs?: Array<{ chainId?: string; priceUsd?: string; liquidity?: { usd?: number }; volume?: { h24?: number }; baseToken?: { address?: string; symbol?: string } }> };
        const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
        for (const pair of pairs) {
          const addr = (pair.baseToken?.address ?? '').toLowerCase();
          if (!addr || !slice.includes(addr)) continue;
          out.set(addr, {
            priceUsd: pair.priceUsd ? Number(pair.priceUsd) || undefined : undefined,
            liquidityUsd: pair.liquidity?.usd,
            volume24hUsd: pair.volume?.h24,
            symbol: pair.baseToken?.symbol,
          });
        }
      } catch {
        // fail-soft: this slice stays unenriched; re-surfaced later
      }
    }
    // PR7: DEXPaprika real 1h/15m/5m volume overlay on the batch that actually
    // has zeros (fresh pairs) — the estimate loses when observed data exists.
    if (this.dexpaprika?.tokenDetail) {
      try {
        await this.overlayDexpaprikaVolume(out, chain, uniq.filter((a) => !out.has(a)));
      } catch {
        // fail-soft — estimate path stays
      }
    }
    return out;
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

  /** Verbose per-token detail lines are gated behind LOG_VERBOSE=true (default
   *  off) so the default Zeabur log stays clean — only cycle-level summaries
   *  and emitted signals print unless an operator opts into the noisy detail. */
  private isVerbose(): boolean {
    return process.env.LOG_VERBOSE === 'true';
  }

  /** Full pass: for each configured chain → collect → prefilter (audit GMGN) → detect → voters → report */
    public async runScreeningPass(): Promise<AgentReport<RobinhoodSignal>[]> {
      console.log('[MEME AGENT] Screening pass started (GMGN OpenAPI)...');
      const reports: AgentReport<RobinhoodSignal>[] = [];
      let scanned = 0;
      let prefiltered = 0;
      // Per-chain scan distribution — makes "only robinhood?" verifiable from
      // the funnel line instead of guessing from which chain is logged last.
      const scannedByChain: Record<string, number> = {};
      // Per-source ingestion — "who provides the most (fresh) pairs" answerable
      // from one line: count candidates by their discovery source.
      const scannedBySource: Record<string, number> = {};

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

        // 0b. Regime CONTEXT (DeFiLlama, hourly-cached, fail-open). Not a voter —
        // just context on the [REGIME] line for the operator/ML layer.
        await this.collectRegimeContext(chain);

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
                  const tapeCandidates = await this.collectTapeCandidates(chain);
                  await this.collectFomoTraderIntel(chain);
                  // Phase 3 — DiscoveryCoordinator owns the funnel mechanics that
                  // used to be inline here: priority order (keyless-DEX first,
                  // indexers last), by-address dedupe with freshLane survival,
                  // DISCOVERY_INTRODUCERS allowlist + best-effort cooldown, and the
                  // GMGN overlay (upgrade existing addresses only, preserving who
                  // FOUND it). tape/track need per-pass state → passed as extras;
                  // GMGN discovery rows ride in as overlay.
                  const allCandidates = await this.discoveryCoordinator.discoverAll(chain, {
                    extras: { tape: tapeCandidates, track: trackCandidates },
                    overlay: gmgnDiscovery,
                  });
        scanned += allCandidates.length;
        scannedByChain[chain] = (scannedByChain[chain] ?? 0) + allCandidates.length;
        for (const t of allCandidates) {
          const src = t.discoveredBy ?? t.source;
          scannedBySource[src] = (scannedBySource[src] ?? 0) + 1;
          // P3.1 Candidate Registry: record per-source firstSeen + latency.
          globalCandidateRegistry.observe({
            chain,
            tokenAddress: t.address,
            source: src as 'rpc' | 'dexpaprika' | 'gecko' | 'dexscreener' | 'gmgn' | 'routescan' | 'ankr' | 'solana-rpc' | 'pons' | 'solanatracker' | 'pumpdev',
            at: Date.now(),
          });
        }
        // P3.1 empirical primary discovery source — the "measure, don't guess"
        // decision input (after weeks of data, this selects the discovery lead).
        const primary = globalCandidateRegistry.primaryDiscoverySource();
        const dstats = globalCandidateRegistry.stats();
        if (primary.primary && primary.bySource[primary.primary]! % 25 === 0) {
          const srcKeys = Object.keys(primary.bySource);
          const promote = srcKeys.filter((s) => sourceParticipation(s) === 'promote');
          const recall = srcKeys.filter((s) => sourceParticipation(s) === 'recall-only');
          console.log(`[DISCOVERY STATS] primary=${primary.primary} bySource=${JSON.stringify(primary.bySource)} promote=[${promote.join(',')}] recall=[${recall.join(',')}] cov=${JSON.stringify(dstats.coverage)} dup=${JSON.stringify(dstats.dupRate)} fp=${JSON.stringify(dstats.falsePositive)} spend=${JSON.stringify(dstats.spend)} candidates=${globalCandidateRegistry.size()}`);
        }
        // Fresh-pair enrichment (batched, gap fix): collect every freshLane
        // candidate that carries zero market data, batch-fetch real
        // price/liquidity/volume from DexScreener /latest/dex/tokens (30 per
        // call), and hydrate them BEFORE the loop so fresh discoveries actually
        // score momentum in the same cycle instead of dying data-less. The
        // prefilter bypass still sees zeros (fresh-at-birth semantics); once
        // enriched, the candidate competes on real numbers.
        const freshEnrichMap = new Map<string, { priceUsd?: number; liquidityUsd?: number; volume24hUsd?: number; volume1hUsd?: number; symbol?: string; buyUsd1h?: number; sellUsd1h?: number }>();
        const freshZero = allCandidates.filter((t) => t.freshLane === true && t.volume1hUsd === 0 && t.liquidityUsd === 0 && t.marketCapUsd === 0);
        if (freshZero.length > 0) {
          try {
            const batched = await this.batchFreshMarketData(freshZero.map((t) => t.address), chain);
            for (const [addr, data] of batched) freshEnrichMap.set(addr, data);
            // Batch-level observability (#2 audit): how many fresh pairs got ANY
            // DexScreener data (vs zero suppliers)? <minFresh pairs are enriched
            // but sub-1000-1h — no winner line fires, so this is the only proof
            // the endpoint works from this network.
            const withData = freshEnrichMap.size;
            if (withData > 0) {
              console.log(`[FRESH LANE] enrichment: ${withData}/${freshZero.length} fresh pairs resolved real market data (${freshZero.length} attempted).`);
            } else {
              console.warn(`[FRESH LANE] enrichment: 0/${freshZero.length} fresh pairs resolved — DexScreener unreachable or pairs not yet indexed (fresh pairs take minutes to appear).`);
            }
          } catch (enrichErr: any) {
            console.warn(`[FRESH LANE] batch enrichment failed (fresh pairs stay zero-data): ${enrichErr.message}`);
          }
        }
        // #3 fresh-pair promotion: track freshLane candidates across cycles and
        // log the ones that matured (volume/liquidity accumulated) — fresh
        // discoveries become visible instead of sitting in the lane silently.
        try {
          const { matured, active } = globalFreshPairWatchlist.track(allCandidates);
          if (matured.length > 0) {
            for (const m of matured) {
              console.log(`[FRESH LANE] ${m.symbol} (${m.chain}) matured: vol1h $${((m.volume1hUsd ?? 0) / 1000).toFixed(1)}k liq $${((m.liquidityUsd ?? 0) / 1000).toFixed(1)}k — now eligible at the mature floor.`);
            }
          }
          // NOTE: `active` is the GLOBAL watchlist size (all chains), not this
          // chain's count — log it as the global total so operators don't read
          // "robinhood: N" as an RH-specific number (RH has no factory feed).
          if (active > 0 && matured.length === 0) {
            console.log(`[FRESH LANE] total ${active} fresh pair(s) across all chains, ${matured.length} matured this cycle.`);
          }
        } catch (watchErr: any) {
          console.warn(`[FRESH LANE] watchlist failed (non-fatal): ${watchErr.message}`);
        }
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
          // P3.6 QLO organic-lift (time-on-curve): for fresh SOL candidates,
          // measure how long the bonding curve took to fill — slow fills are
          // 1.5x/2.4x more likely to 2x/5x post-graduation (qlo, n=97,146).
          // Fail-soft: never blocks the funnel.
          let organicLiftReason: string | undefined;
          if (chain === 'sol' && t.freshLane === true && t.openTimestamp) {
            try {
              const res = await assessSolanaTimeOnCurve(t.address, t.openTimestamp * 1000, this.solTimeOnCurveLoader ?? (async () => ({ signatures: [], nextCursor: null, truncated: false })), {
                chains: ['sol'],
              });
              if (res.organic && res.timeOnCurveMs !== null && res.timeOnCurveMs > 0) {
                const hours = res.timeOnCurveMs / 3600000;
                organicLiftReason = `🌱 Slow-fill ${hours.toFixed(1)}h on curve → ${res.doubleRateLift.toFixed(1)}x/${res.fiveXRateLift.toFixed(1)}x post-grad lift (qlo)`;
              }
            } catch {
              // fail-soft: organic lift unavailable, screening proceeds
            }
          }
          // Graduated-only: reject tokens still on the bonding curve (exchange='pump')
          if (!isGraduatedToken(t)) {
            if (this.isVerbose()) console.log(`[MEME AGENT] ⛔ ${t.symbol}: not yet graduated (bonding curve).`);
            continue;
          }

          const filter = this.preFilter(t, nativePriceUsd);
          if (!filter.ok) {
            this.recordPrefilterRejection(filter.reason, t);
            if (this.isVerbose()) console.log(`[MEME AGENT] ${filter.reason}`);
            continue;
          }
          // Fresh-pair enrichment (gap fix): a freshLane candidate passed the
          // low/bypass floor but carries ZERO market data — it can never score
          // momentum or mature that way. Hydrate from the batched pre-pass map
          // (30 addresses/call) so fresh discoveries actually compete for emit
          // instead of dying data-less (observed live: 213 tracked, 0 matured).
          if (t.freshLane === true) {
            const fresh = freshEnrichMap.get(t.address.toLowerCase());
            if (fresh) {
              t.priceUsd = fresh.priceUsd ?? t.priceUsd;
              t.liquidityUsd = fresh.liquidityUsd ?? t.liquidityUsd;
              const vol24 = fresh.volume24hUsd ?? 0;
              t.volume24hUsd = vol24;
              // PR7: prefer REAL observed 1h volume (DEXPaprika token detail)
              // over the 24h/24 estimate — the prefilter/maturity floor then
              // sees actual short-window flow, not a divisor.
              t.volume1hUsd = fresh.volume1hUsd ?? (vol24 > 0 ? vol24 / 24 : t.volume1hUsd);
              // Real 1h buy/sell USD flow onto the token — the strategy uses
              // this instead of count ratio when present (audit finding).
              if (fresh.buyUsd1h !== undefined) t.buyUsd1h = fresh.buyUsd1h;
              if (fresh.sellUsd1h !== undefined) t.sellUsd1h = fresh.sellUsd1h;
              if (fresh.symbol) t.symbol = fresh.symbol;
              if (t.volume1hUsd >= this.config.minFreshVolume1hUsd) {
                if (this.isVerbose()) console.log(`[FRESH LANE] ${t.symbol} (${t.chain}) enriched: vol1h $${(t.volume1hUsd / 1000).toFixed(1)}k liq $${(t.liquidityUsd / 1000).toFixed(1)}k${fresh.volume1hUsd !== undefined ? ' (real 1h)' : ''}`);
              }
            }
          }
          // Fresh-pair REVALIDATE (strategy-audit #3): the fresh bypass let this
          // token through with zero market data; once enrichment hydrated real
          // numbers, re-run the MATURE floor so a $0-mcap token can't reach the
          // strategy. Fail-closed on what matters, recency on what's fresh.
          if (t.freshLane === true && (t.priceUsd > 0 || t.liquidityUsd > 0 || t.volume24hUsd > 0)) {
            const matureCheck = preFilterToken(t, this.config, nativePriceUsd);
            if (!matureCheck.ok) {
              if (this.isVerbose()) console.log(`[REVALIDATE] ⛔ ${t.symbol}: fresh→mature re-check failed — ${matureCheck.reason}`);
              continue;
            }
            if (t.volume1hUsd > 0 || t.liquidityUsd > 0) {
              if (this.isVerbose()) console.log(`[REVALIDATE] ✓ ${t.symbol}: fresh pair now passes mature gates (vol1h $${(t.volume1hUsd / 1000).toFixed(1)}k liq $${(t.liquidityUsd / 1000).toFixed(1)}k)`);
            }
          }
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
                if (this.isVerbose()) console.log(`[MEME AGENT] ⛔ ${t.symbol}: AUDIT FAIL — GoPlus ${goSec.reasons.join(' ')}`);
                continue;
              }
            } else {
              // GoPlus had no data — GMGN fallback (single call, may be null on 429)
              const gmgnAudit = await this.gmgn.fetchTokenSecurity(chain, t.address);
              const sec = securityAuditGate(gmgnAudit);
              if (!sec.ok) {
                auditFailedReason = `GMGN ${sec.reasons.join(' ')}`;
                if (this.isVerbose()) console.log(`[MEME AGENT] ⛔ ${t.symbol}: AUDIT FAIL — ${auditFailedReason}`);
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
          // P3.6: fold the QLO organic-lift (slow-fill time-on-curve) into the
          // signal reasons when present — the 1.5x/2.4x post-graduation edge.
          if (organicLiftReason && det.type !== 'NONE') {
            det = { ...det, reasons: [...det.reasons, organicLiftReason] };
            if (this.isVerbose()) console.log(`[QLO LIFT] ${t.symbol}: ${organicLiftReason}`);
          }
          // Smart-money cluster (>= 3 wallets buying the same token, fresh) = boost +20
          const trackEntry = trackAcc.get(t.address.toLowerCase());
          const trackLabel = trackEntry ? trackAccumulationLabel(trackEntry) : undefined;
          // P5.1: record persistent-cohort buys + detect convergence. The
          // convergence event is logged but never gates — it's the "3+ smart
          // wallets, same token, <5min" wallet-grounded signal (d1326a).
          if (trackEntry && trackEntry.buyWalletCount >= 1) {
            for (const w of trackEntry.buyWallets) globalPersistenceCohort.recordBuy(w, t.address, Date.now());
            const convergence = globalPersistenceCohort.checkConvergence(
              t.address,
              [...trackEntry.buyWallets].map((h) => ({ handle: h, at: Date.now() })),
            );
            if (convergence && convergence.wallets.length >= 3) {
              if (this.isVerbose()) console.log(`[COHORT CONVERGENCE] ${t.symbol}: ${convergence.wallets.length} persistent wallets on same token <5min`);
            }
          }
          if (trackEntry && trackEntry.buyWalletCount >= 3 && det.type !== 'NONE') {
            det = {
              ...det,
              confidence: Math.min(100, det.confidence + 20),
              reasons: [...det.reasons, `⚡ Cluster of ${trackEntry.buyWalletCount} smart-money wallets bought $${(trackEntry.totalBuyUsd / 1000).toFixed(0)}k (+20)`],
            };
          }
          // Evidence-group cap (#2): the SAME smart-money flow can be counted
          // multiple times — detectMemeSignal (smartDegen), applySignalBoost
          // (+15), track-cluster (+20), strategy (+20). Count the contributing
          // readouts and debias so one phenomenon can't inflate confidence 4×.
          const redundancy =
            (t.smartDegenCount >= 1 ? 1 : 0) +
            (t.ctoFlag ? 1 : 0) +
            (t.renownedCount >= 1 ? 1 : 0) +
            (signalBoostMap.has(t.address.toLowerCase()) ? 1 : 0) +
            (trackEntry && trackEntry.buyWalletCount >= 3 ? 1 : 0);
          const cappedConfidence = capSignalConfidence(det.confidence, Math.max(1, redundancy));
          if (cappedConfidence !== det.confidence) {
            if (this.isVerbose()) console.log(`[EVIDENCE CAP] ${t.symbol}: ${det.confidence}% debiased ${redundancy} correlated readouts → ${cappedConfidence}%`);
            det = { ...det, confidence: cappedConfidence };
          }
          if (det.type === 'NONE' || det.confidence < this.config.passThreshold) {
            if (this.isVerbose()) console.log(`[MEME AGENT] ⚪ ${t.symbol}: ${det.type} ${det.confidence}% < ${this.config.passThreshold}% (${det.reasons.join(' | ')})`);
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
                if (this.isVerbose()) console.log(`[MEME AGENT] ⛔ ${t.symbol}: strategy rejected (${ev.reason})`);
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
            if (this.isVerbose()) console.log(`[MEME AGENT] ⚪ ${t.symbol}: ${det.type} ${confidence}% < ${this.config.passThreshold}% (post-strategy)`);
            continue;
          }

          const thesis = buildMemeThesis(t, det.type, confidence, det.reasons, strategyReason);
          const payload = this.buildPayload(t, confidence, thesis, trackLabel, chain);

          // #1 Point-in-time FeatureSnapshot: immutable, provenance-tagged capture
          // of the decision-time data. Wired so any later observer (Jev/ML/audit)
          // can reconstruct EXACTLY what the bot knew when it called this a signal —
          // no future information can be back-read into it.
          try {
            const snap = buildFeatureSnapshot({
              candidateId: `${chain.toLowerCase()}:${t.address.toLowerCase()}`,
              timestamp: Date.now(),
              strategyVersion: this.strategyEngine.getActiveStrategy('meme-robinhood')?.id,
              modelVersion: 'arch-3-5slot',
              source: { name: t.source ?? 'unknown', fetchedAt: Date.now() },
              market: {
                priceUsd: t.priceUsd,
                liquidityUsd: t.liquidityUsd,
                volume24hUsd: volume24hOf(t),
              },
              flow: {
                buyUsd1h: t.buyUsd1h ?? t.volume1hUsd / 2,
                sellUsd1h: t.sellUsd1h ?? t.volume1hUsd / 2,
              },
              security: { sellable: true }, // sellability proven later in the security block; snapshot defaults conservative
              momentum: { change1hPct: t.priceChange1h ?? 0, mlProb: klines ? predictUpMomentum(klines).score : undefined },
              smartMoney: { smartDegenCount: t.smartDegenCount, kolCount: t.renownedCount },
            });
            (payload as unknown as Record<string, unknown>).featureSnapshot = snap;
            if (this.isVerbose()) {
              console.log(
                `[SNAPSHOT] ${t.symbol} dq=${snap.dataQuality} groups=${snap.evidenceLineage.length} lineage=[${snap.evidenceLineage.map((e) => `${e.group}.${e.field}`).join(',')}]`,
              );
            }
          } catch (snapErr: any) {
            console.warn(`[SNAPSHOT] build failed (signal still fires): ${snapErr.message}`);
          }

          // P1.4 Arkham ENTITY enrichment for this FINALIST (overlay, fail-open,
          // never a gate). Resolves the DEPLOYER/creator wallet (falling back to
          // the token address) to a labeled entity and logs it for the operator —
          // entity/deployer/label is the valuable signal.
          const entity = await this.enrichFinalistEntity(t);
          if (entity && this.isVerbose()) {
            console.log(`[ARKHAM] ${t.symbol} deployer→ ${entity.displayName ?? entity.ownerType}${entity.tags && entity.tags.length ? ` [${entity.tags.slice(0, 3).join(',')}]` : ''}`);
          }

          // Arch-3 voter swarm: assemble opinions for this FINALIST and attach them to the
          // payload — the consensus gate in index.ts re-derives confidence from the weighted
          // average, so the swarm (not the agent) has the final word.
          if (this.voterSwarm) {            // Kernel A reputation read-path: active only when a deployer address is
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
            // P4.2: CoinStats token-risks second read (EVM finalists only,
            // fail-open — GoPlus + RPC remain primary).
            if (this.coinstatsRisk && EVM_AUDIT_CHAINS[chain]) {
              try {
                const cs = await this.coinstatsRisk.screen(EVM_AUDIT_CHAINS[chain], t.address);
                if (cs && cs.penalties.length > 0) {
                  securityPenalties.push(...cs.penalties);
                  if (this.isVerbose()) console.log(`[COINSTATS RISK] ${t.symbol}: ${cs.penalties.join(', ')}`);
                }
              } catch {
                // fail-open — never blocks the funnel
              }
            }
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
                if (buys.length > 0) {
                  (t as any).convergence = { buys };
                  // Second verify signal: confirm the latest buy tx on-chain via RPC.
                  (t as any).rpcVerified = await this.rpcVerifyCrossCheck(chain, buys);
                }
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
              // #1 abstention: no klines is a MISSING input, not a neutral read.
              // Drop the forced 50 — the average renormalizes without momentum.
              opinions.push({ voter: 'ml', score: 50, reasons: ['no klines — abstain'], abstain: true });
            }
            if (this.criticVoter) {
              try {
                opinions.push(await this.criticVoter.evaluate({ token: t, chain, thesis, reasons: det.reasons }));
              } catch (err: any) {
                console.warn(`[MEME AGENT] Critic failed (abstain): ${err.message}`);
                opinions.push({ voter: 'critic', score: 50, reasons: ['critic error — abstain'], abstain: true });
              }
            }
            payload.voterScores = consolidateOpinions(opinions);
          }

          const signal: RobinhoodSignal = { token: t, signalType: det.type, confidence, reasons: det.reasons };

          // #5 Calibrated decision: rawScore (the additive heuristic) and
          // calibratedProbability (real P(win)) are DISTINCT. We always expose
          // the raw score; the probability stays null until a live calibration
          // model is wired — a fabricated probability is worse than none.
          const cal = calibratedDecision({
            rawScore: confidence,
            horizon: '1h',
            model: 'arch3-5slot',
          });
          (payload as unknown as Record<string, unknown>).calibratedDecision = cal;

          // P5.2: Jev shadow-mode decision (never gates). Routes enrichment +
          // regime classification; swarm fallback on any failure.
          if (this.jevRouter && this.jevRouter.enabled()) {
            try {
              const jd = await this.jevRouter.decide({
                rawScore: confidence,
                regime: det.type,
                flow: { buyUsd1h: t.buyUsd1h, sellUsd1h: t.sellUsd1h },
                liquidity: t.liquidityUsd,
                smartMoney: t.smartDegenCount,
              });
              (payload as unknown as Record<string, unknown>).jevDecision = jd;
              if (this.isVerbose()) console.log(`[JEV] ${t.symbol} source=${jd.source} regime=${jd.regime ?? '-'} next=${jd.nextAction ?? '-'} conf=${jd.confidence}`);
            } catch (jevErr: any) {
              console.warn(`[JEV] decide failed (swarm continues): ${jevErr.message}`);
            }
          }
          if (this.isVerbose()) {
            console.log(
              `[CALIBRATED] ${t.symbol} raw=${cal.rawScore} prob=${cal.calibratedProbability !== null ? cal.calibratedProbability.toFixed(2) : 'null (no model yet)'} horizon=${cal.horizon}`,
            );
          }

          reports.push({ passed: true, signal, reason: thesis, confidence, payload });
          console.log(`[MEME AGENT] 🎯 ${det.type} ${t.symbol} ${confidence}% (${chain})`);
        }
      }

      console.log(`[MEME AGENT] Pass complete. ${reports.length} signals passed.`);
      this.logPrefilterRejectionDistribution();
      this.lastFunnel = { scanned, prefiltered, emitted: reports.length };
      const funnelRoles = {
        promote: Object.keys(scannedBySource).filter((s) => sourceParticipation(s) === 'promote').join(','),
        recall: Object.keys(scannedBySource).filter((s) => sourceParticipation(s) === 'recall-only').join(','),
      };
      console.log(`[FUNNEL] meme chains=${chains.join('+')} scanned=${scanned} prefiltered=${prefiltered} emitted=${reports.length} byChain=${Object.entries(scannedByChain).map(([c, n]) => `${c}:${n}`).join(',')} bySource=${Object.entries(scannedBySource).map(([c, n]) => `${c}:${n}`).join(',')} promote=[${funnelRoles.promote}] recall=[${funnelRoles.recall}]`);
      return reports;
      }

      /** Phase-1 funnel stats from the most recent pass (index.ts [FUNNEL] counters). */
      public getLastFunnelStats(): { scanned: number; prefiltered: number; emitted: number } {
      return { ...this.lastFunnel };
      }

  /**
   * Classify a prefilter rejection into a stable diagnostic bucket.
   *
   * The reason string is already built by preFilterToken's `fail()`; this maps
   * it to the FLOOR that bound rather than the token, so the distribution says
   * "volume floor killed 80" instead of restating 80 near-identical lines.
   * Order matters: `sourceUnavailable` is checked first because a dead feed and
   * a dead token must never be conflated (I1-4 `UNAVAILABLE != 0`).
   */
  private prefilterRejectionBucket(reason: string): string {
    const r = reason.toLowerCase();
    if (r.includes('unavailable')) return 'feed-down';
    if (r.includes('volume 1h')) return 'volume-floor';
    if (r.includes('liq')) return 'liquidity-floor';
    if (r.includes('market cap')) return 'marketcap-floor';
    if (r.includes('age')) return 'age-gate';
    if (r.includes('total fee')) return 'fee-floor';
    // securityGateToken joins its own reasons with spaces
    if (r.includes('honeypot')) return 'security-honeypot';
    if (r.includes('tax')) return 'security-tax';
    if (r.includes('rug') || r.includes('insider')) return 'security-rug';
    if (r.includes('top10') || r.includes('top-10') || r.includes('holder')) return 'security-concentration';
    if (r.includes('blacklist') || r.includes('sell')) return 'security-selllock';
    if (r.includes('rat') || r.includes('wash')) return 'security-rats';
    return 'other';
  }

  /** Count one rejection into its bucket for the current pass. */
  private recordPrefilterRejection(reason: string, _t: GMGNRawToken): void {
    const bucket = this.prefilterRejectionBucket(reason);
    this.prefilterRejections.set(bucket, (this.prefilterRejections.get(bucket) ?? 0) + 1);
  }

  /**
   * Emit the per-pass rejection distribution, then reset it.
   *
   * This is the diagnostic that answers "which floor is binding?" without
   * changing any gate. It is a SEPARATE line from [FUNNEL] on purpose: the
   * funnel line is the stable contract that downstream tooling and the
   * stale-gate detector parse, so it must not grow a new field.
   */
  private logPrefilterRejectionDistribution(): void {
    const entries = [...this.prefilterRejections.entries()].sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((n, [, c]) => n + c, 0);
    this.prefilterRejections.clear();
    if (total === 0) return; // nothing rejected — don't emit an empty line
    const body = entries.map(([k, n]) => `${k}:${n}`).join(' ');
    console.log(`[PREFILTER REJECTS] pass total=${total} byFloor=${body}`);
  }

  /** Map GMGNRawToken -> snake_case GMGN field contract consumed by strategy .mjs modules */
  public toStrategyGmgn(t: GMGNRawToken): Record<string, unknown> {
    return toStrategyGmgn(t);
  }
}
