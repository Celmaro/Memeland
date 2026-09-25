import dotenv from 'dotenv';
import { Client, GatewayIntentBits, ChannelType, Events } from 'discord.js';
import { buildCallEmbed } from './discord/embeds/call-embed.js';
import { OpenCatzHub } from './orchestrator/hub.js';
import { dispatchDomain } from './orchestrator/dispatch.js';
import { SwarmConsensusEngine } from './orchestrator/swarm-consensus.js';
import { StrategyEngine } from './orchestrator/strategy-engine.js';
import { PositionManager } from './position/position-manager.js';
import { AIService } from './services/ai-service.js';
import { handleInteraction } from './discord/handlers/interaction-handler.js';
import { handleControlRoomMessage } from './discord/handlers/message-handler.js';
import { globalHealthWatcher } from './services/health-watcher.js';
import { SkillLoader } from './services/skill-loader.js';
import { EVMTradeAdapter } from './adapters/evm-adapter.js';
import { globalLifiExecutor } from './adapters/lifi-executor.js';
import { GMGNAdapter } from './adapters/gmgn-adapter.js';
import { RobinhoodScreeningAgent } from './agents/meme-robinhood/robinhood-screening-agent.js';
import { DexScreenerFeed } from './adapters/dexscreener-feed.js';
import { DexpaprikaFeed } from './adapters/dexpaprika-feed.js';
import { GeckoDiscoveryFeed } from './adapters/gecko-discovery-feed.js';
import { AnkrDiscoveryFeed } from './adapters/ankr-discovery-feed.js';
import { CriticVoter } from './agents/shared/critic-voter.js';
import { priceAlertService, tradeJournalService, walletService, priceFeedService, approvalQueueService } from './discord/handlers/interaction-handler.js';
import { TelegramService } from './telegram/telegram-service.js';
import { StateStore } from './services/state-store.js';
import { OpportunityLedger, sightingFromCallCard } from './services/opportunity-ledger.js';
import { ChatNotifier, discordChannelSink } from './notifications/chat-notifier.js';
import { withScreeningTimeout } from './runtime/screening-runner.js';
import { WalletBalanceReader } from './services/wallet-balance-reader.js';
import { OpportunityStrategist } from './services/opportunity-strategist.js';
import { OpportunityPostMortem } from './services/opportunity-post-mortem.js';
import { globalDecisionLedger } from './services/decision-ledger.js';
import { globalDecisionCache } from './services/decision-cache.js';
import { globalReputationMemory } from './services/reputation-memory.js';
import { ApiKeyGuardService } from './services/api-key-guard.js';
import { WalletTracker } from './services/wallet-tracker.js';
import { executeMemeBuy } from './services/approval-execution.js';
import { gateSafety, gateTxLock, gateSizer, gateFillSim, gateCostGate, gateGovernance, gateSellability } from './services/execution-gates.js';
import { executableChainsFromEnv, normalizeExecutionChainKey } from './config/execution-registry.js';
import { bootstrapStartupConfig, printStartupBanner } from './startup/bootstrap.js';
import { registerGracefulShutdown } from './startup/shutdown.js';
import { createMarketRiskMonitor, startRuntimeMonitoring } from './startup/risk.js';
import { createScreeningCycle } from './startup/screening-cycle.js';
import { runDiscordStartupIntegrations, isControlRoomChannel } from './startup/integrations.js';
import { globalOperationalHealth } from './services/operational-health.js';
import { createOperationalFunnel, mergeOperationalFunnel, funnelCountersFromState } from './services/operational-funnel.js';

dotenv.config();

bootstrapStartupConfig();
printStartupBanner();

const telegramService = new TelegramService();
const apiKeyGuard = new ApiKeyGuardService();

// Live-trading safety gate: refuse to start in live execution unless every
// independent safeguard is explicitly acknowledged. This is the enforcement of
// the "secure defaults" posture — trusting DRY_RUN=true + AUTO_EXECUTE_ENABLED
// default values is fine, but flipping to live must be an explicit, multi-flag,
// deliberate decision. Fail startup rather than trade unacknowledged.
// Initialize persistent StateStore (survives bot restarts)
const stateStore = new StateStore();
globalOperationalHealth.setFunnel(funnelCountersFromState(stateStore.getFunnelStats()));

const hub = new OpenCatzHub();
const swarmEngine = new SwarmConsensusEngine();
swarmEngine.attachStateStore(stateStore);

// Opportunity lifecycle ledger + Strategist (build step 1-2). Pure additions —
// the ledger records every fired signal and the Strategist decides which
// opportunities to re-score and when (throttled by nextReviewAt). The live loop
// ingests fired signals and records the real approval outcome; nothing here
// gates execution, so it can never block the existing pipeline.
const opportunityLedger = new OpportunityLedger();
const opportunityStrategist = new OpportunityStrategist(opportunityLedger);
const opportunityPostMortem = new OpportunityPostMortem(opportunityLedger, (success: boolean) => {
  import('./orchestrator/swarm-learning.js')
    .then((m) => m.globalSwarmLearning.recordAttributedOutcome(success))
    .catch((learnErr: any) => console.warn(`[SWARM LEARNING] post-mortem feed failed: ${learnErr.message}`));
});

// Wire sandboxed StrategyEngine into Swarm Consensus (active strategy can adjust confidence)
const strategyEngine = new StrategyEngine();
SwarmConsensusEngine.setStrategyProvider((domain: string) => strategyEngine.getActiveStrategy(domain));

function gateSignal(payload: any): boolean {
  // Kernel B — feed the azimuth sticky-conviction keys into the consensus
  // guard so the sticky-conviction and circuit-breaker checks hold live.
  const res = swarmEngine.evaluateSignal({
    symbol: payload.symbol || 'CUSTOM',
    domain: payload.domain || 'MEME_ROBINHOOD',
    contractAddress: payload.contractAddress || '',
    liquidityUsd: Number(payload.liquidityUsd) || 0,
    volume1hUsd: Number(payload.volume1hUsd) || 0,
    securityAuditPassed: Boolean(payload.securityAuditPassed),
    socialHypeScore: Number(payload.socialHypeScore) || 0,
    confidence: Number(payload.confidenceScore) || undefined,
    // Arch-3 voter swarm: when the agent attached per-voter scores, the gate
    // re-derives confidence from the weighted average (voters.ts).
    voterScores: payload.voterScores || undefined,
    stickyKey: `${payload.domain || 'MEME_ROBINHOOD'}:${payload.network || 'chain'}:${payload.symbol || 'CUSTOM'}`.toUpperCase(),
  });
  if (!res.passed) {
    const refusal = res.decision && !res.decision.allowed ? ` [${res.decision.refusal}]` : '';
    console.warn(`[CONSENSUS GATE] ${payload.domain} ${payload.symbol} rejected (confidence ${res.confidenceScore}%)${refusal} — not posting.`);
  }
  return res.passed;
}


// KC5 — ChatNotifier replaces the legacy controlRoomNotifyCooldown Map +
// notifyControlRoom helper. The notifier owns the per-key cooldown and the
// Discord-channel-finder sink, with the standalone-engine stdout fallback
// built-in. The discordChannelSink is bound lazily via bindDiscordClient().
const CONTROL_ROOM_NOTIFY_MS = 10 * 60 * 1000; // max 1 notif per key per 10 minutes
const controlRoomNotifier = new ChatNotifier({
  cooldownMs: CONTROL_ROOM_NOTIFY_MS,
  sink: (key, content) => console.log(`[NOTIFY/standalone] ${key}: ${content}`),
});
function bindDiscordClient(client: any): void {
  // Replace the stdout fallback sink with the discord channel-finder so
  // notifications route to Discord whenever a client is available.
  (controlRoomNotifier as unknown as { sink: (k: string, c: string) => Promise<void> }).sink =
    discordChannelSink(client);
}

// 5-chain keyless-first scope needs ~90-120s per pass (discovery + per-token
// GMGN audits at 600ms spacing); the legacy 60s default silently discarded
// every pass (funnel beforeGate=0). Default 180s; env can still override.
const SCREENING_TIMEOUT_MS = Math.max(1000, Number(process.env.SCREENING_TIMEOUT_MS) || 180000);
// withScreeningTimeout imported from src/runtime/screening-runner.js (KC6).
// Semantics identical to the legacy inline helper: fail-closed, resolves []
// when a pass exceeds SCREENING_TIMEOUT_MS, timer cleared on settle.

// Legacy wrapper — keeps the 5 existing call sites intact. Internally routes
// through ChatNotifier, which owns the cooldown + sink. The client argument
// is now ignored — bindDiscordClient() rebinds the sink for live routing.
async function notifyControlRoom(client: any, key: string, content: string): Promise<void> {
  void client;
  await controlRoomNotifier.post(key, content);
}

const positionManager = new PositionManager();
positionManager.attachStateStore(stateStore);
positionManager.attachOpportunityLedger(opportunityLedger);

// KC7 — single balance-reader surface (defaults to Robinhood Chain 4663).
const globalWalletBalanceReader = new WalletBalanceReader(walletService);

// Wallet auto-tracker: mirrors user's on-chain holdings into PositionManager lifecycle + exit alerts
const walletTracker = new WalletTracker({ positionManager, stateStore, gmgn: new GMGNAdapter(), walletService, tradeJournal: tradeJournalService });

const aiService = new AIService();

// Startup strategy bootstrap: if strategies/custom-strategy-prompt.txt exists, generate
// per-domain custom strategies via LLM (validated + activated). try/catch guarantees a
// bootstrap failure never crashes boot — defaults stay active.
try {
  const { bootstrapCustomStrategies } = await import('./orchestrator/strategy-bootstrap.js');
  await bootstrapCustomStrategies({ aiService });
} catch (err: any) {
  console.warn(`[STRATEGY BOOTSTRAP] Failed to bootstrap custom strategies: ${err.message}`);
}

const skillLoader = new SkillLoader();
const evmTradeAdapter = new EVMTradeAdapter();

// Apply persisted per-domain screening overrides (set via chat `set_screening_config`).
// Agent-level prefilter/hard-gate thresholds are seeded from the ACTIVE strategy's
// prefilter* params (loosened presets take effect at runtime); fallback = config.
// Arch-3 voter swarm: enabled unless VOTER_SWARM_ENABLED=false; the Critic voter gets
// the AIService (fail-open neutral when LLM is unavailable).
const savedScreeningConfigs = stateStore.getScreeningConfigs();
const robinhoodScreeningAgent = new RobinhoodScreeningAgent(
  savedScreeningConfigs['meme-robinhood'] as any,
  () => strategyEngine.getActiveStrategy('meme-robinhood')?.params ?? {},
  {
    voterSwarm: process.env.VOTER_SWARM_ENABLED !== 'false',
    critic: new CriticVoter(aiService),
    // Q06 keyless DexScreener booster feed. Inert unless DEXSCREENER_FEED_ENABLED=true.
    dexscreener: new DexScreenerFeed(),
    dexpaprika: new DexpaprikaFeed(),
    // SRC-153 GeckoTerminal keyless discovery tier (new_pools + trending).
    // Inert unless GECKO_FEED_ENABLED=true. Self-paced to the 30/min budget.
    gecko: new GeckoDiscoveryFeed(),
    // B4: on-chain PairCreated discovery through the RPC pool (keyless, Ankr-style).
    // Inert unless ANKR_FEED_ENABLED=true — closes the sub-indexer freshness gap.
    ankr: process.env.ANKR_FEED_ENABLED === 'true' ? new AnkrDiscoveryFeed() : null,
  },
);
// Wire shared adapters + singleton agent instances into the Hub
hub.attachAgentFactories({
  'meme-robinhood': () => robinhoodScreeningAgent,
});

// Attach StateStore to all persistent services
hub.attachStateStore(stateStore);
priceAlertService.attachStateStore(stateStore);
tradeJournalService.attachStateStore(stateStore);
walletService.attachStateStore(stateStore);
approvalQueueService.attachStateStore(stateStore);

const loadedSkills = skillLoader.loadAllSkills();

// Memeland fork boot summary. Names the live 9-voter swarm, the only execution
// layer (LI.FI/Jumper), and the skills the runtime actually loaded. The
// kernel map (A–G + L–R) is printed earlier by printStartupBanner() in
// startup/bootstrap.ts — see docs/KERNEL_CATALOG.md for the full surface.
console.log(`[SWARM] voters=9 (quant/ml/security/sentiment/whale/critic/wallet/convergence/rubric) | gate=swarm-consensus≥80% | floor=NEVER-LOWERED`);
console.log(`[EXECUTION] lifi-executor (LI.FI/Jumper — only execution layer on this fork) | adapters=evm-robinhood,gmgn-rest-client | cycles=${loadedSkills.length} skills loaded (${loadedSkills.map(s => s.name).join(', ')})`);
console.log(`[AI] provider=${aiService.getConfig().provider} model=${aiService.getConfig().modelName}`);

const discordToken = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
let runtimeStop: (() => void) | null = null;

// Discord client reference for standalone engine (null when Discord is not configured).
let activeClient: any = null;

// Signal dedup window: prevents posting same signal within 2 hours (persisted
// across restarts). Quick win: the in-memory dedup Map moved to Kernel F's
// sticky cache (globalDecisionCache.getSticky); the persisted timestamps seed
// it at boot via primeSticky.
const DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours (GMGN trending returns the same top tokens)
for (const [k, v] of Object.entries(stateStore.getAllDedupEntries())) {
  globalDecisionCache.primeSticky(k, v, v);
}

// Start 24/7 Sub-Agents Background Screening Interval Loop (Immediate pass on boot + Every 5 minutes)
// Kernel S — cycle body moved to src/startup/screening-cycle.ts (createScreeningCycle).
const runScreeningCycle = createScreeningCycle({
  hub, globalHealthWatcher, globalWalletBalanceReader, priceFeedService, stateStore,
  dispatchDomain, robinhoodScreeningAgent,
  apiKeyGuard, gateSignal, createOperationalFunnel, mergeOperationalFunnel,
  globalOperationalHealth, DEDUP_WINDOW_MS, sightingFromCallCard,
  opportunityStrategist, opportunityLedger, approvalQueueService, executeMemeBuy,
  evmTradeAdapter, walletService, tradeJournalService, gateSafety, gateTxLock, gateSizer,
  gateFillSim, gateCostGate, gateGovernance, gateSellability, globalLifiExecutor,
  globalDecisionLedger, normalizeExecutionChainKey, executableChainsFromEnv, buildCallEmbed,
  telegramService, getActiveClient: () => activeClient, walletTracker, positionManager,
  globalReputationMemory, GMGNAdapter, notifyControlRoom, opportunityPostMortem,
  ChannelType, SCREENING_TIMEOUT_MS, withScreeningTimeout,
});
// Scheduler and the independent market-risk monitor are owned by the startup module.
const marketSentinel = createMarketRiskMonitor();
const runtime = startRuntimeMonitoring({ runCycle: runScreeningCycle, marketSentinel });
runtimeStop = runtime;
for (const status of runtime.statuses()) {
  globalOperationalHealth.setSchedulerStatus(status);
}

if (discordToken && clientId) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    rest: {
      // Increase Discord REST timeout (default 10s) — VPS previously timed out during
      // restart + bootstrap + reply simultaneously, causing "Opencatz is thinking..."
      timeout: 30000,
    },
  });
  activeClient = client;

  client.once(Events.ClientReady, async () => {
    console.log(`[DISCORD BOT] Logged in as ${client.user?.tag}!`);
    globalOperationalHealth.setDelivery({ discord: true, telegram: telegramService.isEnabled(), lastDiscordAt: Date.now() });
    await runDiscordStartupIntegrations({
      client,
      discordToken,
      clientId,
      telegramService,
      hub,
      walletService,
      aiService,
    });
    if (telegramService.isEnabled()) {
      globalOperationalHealth.setDelivery({ telegram: true, lastTelegramAt: Date.now() });
    }

    // Start Price Alert Checking Interval Loop (Every 60s)
    setInterval(async () => {
      try {
        const triggered = await priceAlertService.checkAlerts(priceFeedService);
        for (const alert of triggered) {
          const targetChannelId = alert.channelId || process.env.DISCORD_CHANNEL_CONTROL_ROOM;
          if (targetChannelId && client.channels.cache.has(targetChannelId)) {
            const channel = client.channels.cache.get(targetChannelId) as any;
            const currentPx = alert.lastTriggeredPriceUsd || alert.targetPriceUsd;
            if (channel && 'send' in channel) {
              const alertMsg =
                `🔔 **OPENCATZ PRICE ALERT TRIGGERED!**\n\n` +
                `📈 **Asset:** \`${alert.symbol}/USDT\`\n` +
                `💵 **Target Price Hit:** \`$${alert.targetPriceUsd.toLocaleString()} USD\` (Current: \`$${currentPx.toLocaleString()} USD\`)\n` +
                `👤 **Alert for:** <@${alert.userId}>\n` +
                `🎯 **Condition:** Price reached \`${alert.direction}\` target!`;
              await channel.send(alertMsg);
            }
          }
        }
      } catch (err: any) {
        console.error('[PRICE ALERT LOOP ERROR]', err.message);
      }
    }, 60 * 1000);

  });

  client.on('interactionCreate', (interaction) => {
    handleInteraction(interaction, hub, aiService);
  });

  client.on('messageCreate', (message) => {
    if (message.author.bot) return;
    const chName = (message.channel && 'name' in message.channel ? (message.channel as any).name : '').toLowerCase();
    const isAuditChannel = chName === 'opencatz-audit' || chName === 'opencat-audit' || chName === 'audit-on-demand';
    const controlRoomChannelId = process.env.DISCORD_CHANNEL_CONTROL_ROOM;

    if (isAuditChannel || isControlRoomChannel(controlRoomChannelId, message)) {
      handleControlRoomMessage(message, hub, aiService);
    }
  });

  client.login(discordToken).catch((err) => {
    console.warn(`[DISCORD BOT] Login skipped or failed: ${err.message}. Running in offline simulation mode.`);
  });
  // KC5 — rebind the notifier sink to use the live Discord client.
  bindDiscordClient(client);
} else {
  console.log('[DISCORD BOT] DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID not set in .env. Running standalone engine.');
}

// Memeland fork ready. Lists what's live (active domains + the persisted-state
// counters that survived this restart) so the operator's first log glance
// answers "what's running" without running a healthcheck.
console.log(`[SYSTEM] Memeland fork ready | domains=${hub.getActiveDomains().join('+') || 'none'} | openPositions=${stateStore.getAllPositions().length} | alerts=${stateStore.getAllPositions().length === 0 ? 'n/a' : 'see dashboard'} | state-file=database/opencatz_state.json`);
console.log('[STATE STORE] Persistent state engine active — positions, alerts, and journal survive restarts.');

// Start OpenCatz Telemetry & REST API Server
import { OpenCatzRESTServer } from './api/server.js';
const apiServer = new OpenCatzRESTServer();
apiServer.start(hub);

// Graceful Shutdown: stop the runtime schedulers, flush pending state writes to
// disk, then close the REST API before exiting.
registerGracefulShutdown('SIGINT', {
  flush: () => stateStore.flushToDisk(),
  stop: async () => {
    runtimeStop?.();
    await apiServer.stop();
  },
});
registerGracefulShutdown('SIGTERM', {
  flush: () => stateStore.flushToDisk(),
  stop: async () => {
    runtimeStop?.();
    await apiServer.stop();
  },
});
