import dotenv from 'dotenv';
import { isDryRun as isDryRunMode, isAutoExecute, isSignalOnly } from './config/config.js';
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
import { globalMarketRegimeFilter, computeWhaleRiskOff } from './services/market-regime.js';
import { SkillLoader } from './services/skill-loader.js';
import { EVMTradeAdapter } from './adapters/evm-adapter.js';
import { GMGNAdapter } from './adapters/gmgn-adapter.js';
import { HyperliquidAdapter } from './adapters/hyperliquid-adapter.js';
import { RobinhoodScreeningAgent } from './agents/meme-robinhood/robinhood-screening-agent.js';
import { WhaleScreeningAgent } from './agents/whale-eth/whale-screening-agent.js';
import { CriticVoter } from './agents/shared/critic-voter.js';
import { priceAlertService, tradeJournalService, walletService, priceFeedService, approvalQueueService } from './discord/handlers/interaction-handler.js';
import { TelegramService } from './telegram/telegram-service.js';
import { StateStore } from './services/state-store.js';
import { OpportunityLedger } from './services/opportunity-ledger.js';
import { OpportunityStrategist } from './services/opportunity-strategist.js';
import { OpportunityPostMortem } from './services/opportunity-post-mortem.js';
import { ApiKeyGuardService } from './services/api-key-guard.js';
import { globalRiskEngineV2 } from './orchestrator/risk-engine-v2.js';
import { WalletTracker } from './services/wallet-tracker.js';
import { executeMemeBuy } from './services/approval-execution.js';
import { gateSafety, gateTxLock, gateSizer, gateFillSim, gateCostGate, gateGovernance } from './services/execution-gates.js';
import { bootstrapStartupConfig, printStartupBanner } from './startup/bootstrap.js';
import { registerGracefulShutdown } from './startup/shutdown.js';
import { createMarketRiskMonitor, startRuntimeMonitoring } from './startup/risk.js';
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
hub.setStrategyProvider((domain: string) => strategyEngine.getActiveStrategy(domain));

function gateSignal(payload: any): boolean {
  const res = swarmEngine.evaluateSignal({
    symbol: payload.symbol || 'CUSTOM',
    domain: payload.domain || 'MEME_ROBINHOOD',
    contractAddress: payload.contractAddress || '',
    liquidityUsd: Number(payload.liquidityUsd) || 0,
    volume1hUsd: Number(payload.volume1hUsd) || 0,
    securityAuditPassed: Boolean(payload.securityAuditPassed),
    socialHypeScore: Number(payload.socialHypeScore) || 0,
    confidence: Number(payload.confidenceScore) || undefined,
    // Arch-3 7-voter swarm: when the agent attached per-voter scores, the gate
    // re-derives confidence from the weighted average (voters.ts).
    voterScores: payload.voterScores || undefined,
  });
  if (!res.passed) {
    const refusal = res.decision && !res.decision.allowed ? ` [${res.decision.refusal}]` : '';
    console.warn(`[CONSENSUS GATE] ${payload.domain} ${payload.symbol} rejected (confidence ${res.confidenceScore}%)${refusal} — not posting.`);
  }
  return res.passed;
}

/** Build an opportunity sighting from a gate-passed call payload (ledger identity). */
function strategistSightingFrom(item: { payload: import('./agents/shared/agent-contract.js').CallCardPayload; channelName: string }): import('./services/opportunity-ledger.js').OpportunitySighting | null {
  const payload = item.payload;
  if (!payload?.contractAddress) return null;
  const price = parseFloat(String(payload.priceUsd || '0').replace(/[^0-9.]/g, '')) || 0;
  return {
    chain: String(payload.network || 'robinhood').toLowerCase(),
    contractAddress: payload.contractAddress,
    symbol: payload.symbol,
    source: item.channelName === 'call-meme-robinhood' ? 'swarm:gate' : 'whale:gate',
    priceUsd: price > 0 ? price : undefined,
    liquidityUsd: payload.liquidityUsd > 0 ? payload.liquidityUsd : undefined,
  };
}

// Rate-limited Discord notification to #opencatz-control-room (never spam)
const controlRoomNotifyCooldown = new Map<string, number>();
const CONTROL_ROOM_NOTIFY_MS = 10 * 60 * 1000; // max 1 notif per key per 10 minutes

const SCREENING_TIMEOUT_MS = Math.max(1000, Number(process.env.SCREENING_TIMEOUT_MS) || 60000);
function withScreeningTimeout<T>(promise: Promise<T>, domain: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      console.warn(`[SCREENING TIMEOUT] ${domain.toUpperCase()} pass exceeded ${SCREENING_TIMEOUT_MS}ms — discarded, no signals emitted (fail-closed).`);
      resolve([] as unknown as T);
    }, SCREENING_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function notifyControlRoom(client: any, key: string, content: string): Promise<void> {
  const now = Date.now();
  const last = controlRoomNotifyCooldown.get(key);
  if (last && now - last < CONTROL_ROOM_NOTIFY_MS) return;
  controlRoomNotifyCooldown.set(key, now);
  if (!client) {
    // No Discord client (standalone engine): emit to stdout so the operator
    // sees the same notification that would have been posted to #control-room.
    console.log(`[NOTIFY/standalone] ${key}: ${content}`);
    return;
  }
  try {
    const channel = client.channels.cache.find(
      (c: any) => c.type === ChannelType.GuildText && (c.name === 'opencatz-control-room' || c.name === 'opencat-control-room')
    );
    if (channel && 'send' in channel) {
      await channel.send(content);
    }
  } catch (err: any) {
    console.warn(`[NOTIFY] Control room notification failed (${key}): ${err.message}`);
  }
}

const positionManager = new PositionManager();
positionManager.attachStateStore(stateStore);
positionManager.attachOpportunityLedger(opportunityLedger);
const { PositionScanner } = await import('./services/position-scanner.js');
const positionScanner = new PositionScanner({ positionManager, walletService, stateStore });

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
  },
);
const hyperliquidAdapter = new HyperliquidAdapter();
const whaleScreeningAgent = new WhaleScreeningAgent(hyperliquidAdapter);

// Wire shared adapters + singleton agent instances into the Hub
hub.attachAgentFactories({
  'meme-robinhood': () => robinhoodScreeningAgent,
  'whale-eth': () => whaleScreeningAgent,
});

// Attach StateStore to all persistent services
hub.attachStateStore(stateStore);
priceAlertService.attachStateStore(stateStore);
tradeJournalService.attachStateStore(stateStore);
walletService.attachStateStore(stateStore);
approvalQueueService.attachStateStore(stateStore);

const loadedSkills = skillLoader.loadAllSkills();

console.log(`[SKILL SYSTEM] Active skills loaded: ${loadedSkills.length} (${loadedSkills.map(s => s.name).join(', ')})`);
console.log(`[SECURITY SERVICES] GMGN + GoPlus Security Initialized (sol/bsc/base/eth/robinhood).`);
console.log(`[SCREENING AGENTS] Multi-Chain Meme (7-voter swarm) + ETH Whale Tracking Agents Initialized.`);
console.log(`[SCREENING ADAPTERS] GMGN AI + GoPlus + Relay + Hyperliquid + EVM Adapters Initialized.`);
console.log(`[AI SERVICE] Configured with provider: ${aiService.getConfig().provider}, model: ${aiService.getConfig().modelName}`);

const discordToken = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
let runtimeStop: (() => void) | null = null;

// Discord client reference for standalone engine (null when Discord is not configured).
let activeClient: any = null;

// Signal dedup cache: prevents posting same signal within 2-hour window (persisted across restarts)
const recentSignals = new Map<string, number>(); // key: "channel:symbol:ca" -> timestamp
for (const [k, v] of Object.entries(stateStore.getAllDedupEntries())) {
  recentSignals.set(k, v);
}
const DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours (GMGN trending returns the same top tokens)

// Real portfolio equity tracker (feeds RiskManager drawdown)
let prevPortfolioEquityUsd: number | null = null;

// Start 24/7 Sub-Agents Background Screening Interval Loop (Immediate pass on boot + Every 5 minutes)
const runScreeningCycle = async () => {
  const cycleOperationalFunnel = createOperationalFunnel();
  globalOperationalHealth.setSchedulerStatus({ name: 'screening', running: true, lastStartedAt: Date.now() });
  globalOperationalHealth.recordProviderRequest('screening-pass', true);
  console.log('[SUB-AGENTS LOOP] Checking active sub-agent domains...');
  try {
    // Register heartbeats AT THE START of each pass so agents are marked alive while the
    // loop is running (loop interval 5m > watcher timeout, so end-of-pass heartbeats alone
    // would always trip the UNRESPONSIVE threshold between passes).
    for (const domain of hub.getActiveDomains()) {
      globalHealthWatcher.recordHeartbeat(domain);
    }
    // Real portfolio equity -> drawdown (fail-soft: skip if data unavailable)
    try {
      let currentEquityUsd = 0;
      const ethBal = await walletService.getEvmBalance(4663);
      const ethPrice = await priceFeedService.getPrice('ETH');
      if (ethBal && ethPrice !== null) currentEquityUsd += ethBal.balance * ethPrice;
      const openPositions = stateStore.getAllPositions();
      for (const p of openPositions) {
        currentEquityUsd += (p.currentPriceUsd ?? 0) * (p.amount ?? 0);
      }
      if (prevPortfolioEquityUsd !== null) {
        hub.getRiskManager().updateDrawdown(currentEquityUsd, prevPortfolioEquityUsd);
      }
      prevPortfolioEquityUsd = currentEquityUsd;
    } catch (equityErr: any) {
      console.warn(`[RISK] Portfolio equity unavailable this pass: ${equityErr.message}`);
    }

    // Real market regime from live BTC/ETH 24h changes (fail-soft when unavailable)
    try {
      const btcChange = await priceFeedService.get24hChange('BTC');
      const ethChange = await priceFeedService.get24hChange('ETH');
      if (btcChange !== null && ethChange !== null) {
        const volIdx = Math.min(100, Math.round(Math.max(Math.abs(btcChange), Math.abs(ethChange)) * 15));
        globalMarketRegimeFilter.updateMarketRegime(btcChange, ethChange, volIdx);
      }
    } catch (regimeErr: any) {
      console.warn(`[MARKET REGIME] Update failed: ${regimeErr.message}`);
    }

    let dispatchedPayloads: Array<{ payload: import('./agents/shared/agent-contract.js').CallCardPayload; channelName: string; rawReason: string }> = [];

            const robinhoodDispatched = await dispatchDomain({
              domain: 'meme-robinhood',
              channelName: 'call-meme-robinhood',
              isActive: () => hub.isAgentActive('meme-robinhood'),
              runPass: () => withScreeningTimeout(robinhoodScreeningAgent.runScreeningPass(), 'meme-robinhood'),
              keyReady: () => apiKeyGuard.checkDomainKeys('meme-robinhood'),
            });
            dispatchedPayloads.push(...robinhoodDispatched);

            const whaleDispatched = await dispatchDomain({
              domain: 'whale-eth',
              channelName: 'call-whale-eth',
              isActive: () => hub.isAgentActive('whale-eth'),
              runPass: () => withScreeningTimeout(whaleScreeningAgent.runScreeningPass(), 'whale-eth'),
              keyReady: () => apiKeyGuard.checkDomainKeys('whale-eth'),
            });
            dispatchedPayloads.push(...whaleDispatched);

            // Feed Hyperliquid ETH whale net positioning into the regime filter as a
            // risk-off overlay (takes effect from the next cycle — a slow-moving signal).
            const whaleSignal = whaleScreeningAgent.getLastSignal();
            if (whaleSignal) {
              const whaleRegime = computeWhaleRiskOff(whaleSignal.totalLongUsd, whaleSignal.totalShortUsd);
              globalMarketRegimeFilter.setWhaleRiskOff(
                whaleRegime.riskOff,
                `Hyperliquid ETH whales net $${(whaleSignal.netUsd / 1e6).toFixed(1)}M (short share ${whaleRegime.shortSharePct}%)`
              );
            }

    // Real Swarm Consensus gate (>= 80%): every signal must pass with real data
    const preGateCount = dispatchedPayloads.length;
    dispatchedPayloads = dispatchedPayloads.filter((item) => gateSignal(item.payload));
    const postGateCount = dispatchedPayloads.length;
    stateStore.incrementFunnel('meme-robinhood', 'scanned', robinhoodScreeningAgent.getLastFunnelStats().scanned);
    stateStore.incrementFunnel('meme-robinhood', 'consensus', postGateCount);
    cycleOperationalFunnel.sourcesQueried += Math.max(1, hub.getActiveDomains().length);
    cycleOperationalFunnel.candidatesDiscovered += robinhoodScreeningAgent.getLastFunnelStats().scanned;
    cycleOperationalFunnel.candidatesNormalized += robinhoodScreeningAgent.getLastFunnelStats().prefiltered;
    cycleOperationalFunnel.candidatesEnriched += preGateCount;
    cycleOperationalFunnel.candidatesRejectedByGate += Math.max(0, preGateCount - postGateCount);
    cycleOperationalFunnel.signalsEmitted += postGateCount;
    console.log(`[FUNNEL] cycle: agents=${hub.getActiveDomains().join('+')} beforeGate=${preGateCount} afterGate=${postGateCount} (cumulative: ${JSON.stringify(stateStore.getFunnelStats()['meme-robinhood'] || {})})`);

    // Register real heartbeats for every active agent that ran this pass
    for (const domain of hub.getActiveDomains()) {
      globalHealthWatcher.recordHeartbeat(domain);
    }

    // Purge expired dedup entries
    const now = Date.now();
    for (const [key, ts] of recentSignals.entries()) {
      if (now - ts > DEDUP_WINDOW_MS) recentSignals.delete(key);
    }

    // Phase-3 AUTO gate expectancy source: TP/SL counts from the live scorecard.
    const scorecardExpectancy = () => {
      const closed = stateStore.getScorecard().filter((e) => e.status !== 'OPEN');
      return {
        tp: closed.filter((e) => e.status === 'TP').length,
        sl: closed.filter((e) => e.status === 'SL').length,
      };
    };

    // Dispatch all passed signals to Discord channels & Telegram topics (with dedup)
    const firedOpportunities: Array<{ id: string; confidence: number }> = [];
    for (const item of dispatchedPayloads) {
      const dedupKey = `${item.channelName}:${item.payload.symbol}:${item.payload.contractAddress || 'N/A'}`;
      if (recentSignals.has(dedupKey)) {
        console.log(`[DEDUP] Skipping duplicate signal: ${dedupKey} (posted ${((now - recentSignals.get(dedupKey)!) / 60000).toFixed(0)}m ago)`);
        continue;
      }
      recentSignals.set(dedupKey, now);
      stateStore.setDedupEntry(dedupKey, now);
      globalOperationalHealth.recordAlert(
        'CONSENSUS_PASS',
        `Consensus pass: ${item.payload.symbol}`,
        `${item.channelName} confidence ${Number(item.payload.confidenceScore) || 0}%`
      );

      // Opportunity ledger: ingest every fired signal so the Strategist can
      // re-score/re-admit it over time. Never gates anything (fail-soft).
      try {
        const sighting = strategistSightingFrom(item);
        if (sighting) {
          firedOpportunities.push({
            id: opportunityStrategist.ingest(sighting).opportunityId,
            confidence: Number(item.payload.confidenceScore) || 0,
          });
        }
      } catch (ledgerErr: any) {
        console.warn(`[OPPORTUNITY LEDGER] ingest failed (${item.payload.symbol}): ${ledgerErr.message}`);
      }

      // Phase-1 scorecard + funnel: this signal FIRED — open a predicted-vs-actual entry
      stateStore.incrementFunnel('meme-robinhood', 'fired');
      let scorecardId: string | undefined;
      {
        const firedPrice = parseFloat(String(item.payload.priceUsd || '0').replace(/[^0-9.]/g, '')) || 0;
        if (firedPrice > 0) {
          scorecardId = `SC_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          stateStore.appendScorecardEntry({
            id: scorecardId,
            symbol: item.payload.symbol || 'TOKEN',
            chain: String(item.payload.network || 'robinhood').toLowerCase(),
            contractAddress: item.payload.contractAddress || '',
            confidence: Number(item.payload.confidenceScore) || 0,
            entryPriceUsd: firedPrice,
            currentPriceUsd: firedPrice,
            entryTimestampIso: new Date().toISOString(),
            updatedAtIso: new Date().toISOString(),
            status: 'OPEN',
          });
        }
      }

      // Phase-2 APPROVAL ladder: queue this gate-passed meme signal as a
      // PENDING order for one-click Approve/Cancel on the call card. AUTO
      // stays locked until the approved-fill + expectancy gate opens.
      let approvalOrderId: string | undefined;
      if (item.channelName === 'call-meme-robinhood' && item.payload.contractAddress) {
        const queuedPrice = parseFloat(String(item.payload.priceUsd || '0').replace(/[^0-9.]/g, '')) || 0;
        const order = approvalQueueService.enqueue(
          {
            domain: 'meme-robinhood',
            symbol: item.payload.symbol || 'TOKEN',
            contractAddress: item.payload.contractAddress,
            chain: String(item.payload.network || 'robinhood').toLowerCase(),
            entryPriceUsd: queuedPrice,
            suggestedSizeUsd: (hub.isAutoExecuteEnabled('meme-robinhood').maxTradeAmount || 0.1) * (queuedPrice || 1),
            confidence: Number(item.payload.confidenceScore) || 0,
            thesis: (item.rawReason || item.payload.aiThesis || '').slice(0, 300),
          },
          { scorecardId }
        );
        approvalOrderId = order.id;
        console.log(`[APPROVAL] Queued PENDING order ${order.id} for ${item.payload.symbol} (scorecard ${scorecardId || 'n/a'})`);
        globalOperationalHealth.recordAlert('APPROVAL_REQUIRED', `Approval required: ${item.payload.symbol}`, `order ${order.id}`);
      }

      // Execution Mode check: AUTO_EXECUTE executes live trades, DRY_RUN simulates with real market quotes, SIGNAL_ONLY skips trade execution.
      const AUTO_EXECUTE_ENABLED = isAutoExecute() || process.env.AUTO_EXECUTE_ENABLED === 'true';
                const autoExecDomain: string | undefined =
                  item.channelName === 'call-meme-robinhood' ? 'meme-robinhood' : undefined;
      if (autoExecDomain && AUTO_EXECUTE_ENABLED && !isSignalOnly()) {
        // Phase-3 AUTO gate: execution only opens once the approved-fill floor
        // (N > 50) AND positive expectancy (closed win rate > 50%) are proven.
        const phaseGate = approvalQueueService.canAutoExecute(scorecardExpectancy());
        if (!phaseGate.allowed) {
          console.warn(`[AUTO-EXECUTE] ${autoExecDomain} ${item.payload.symbol}: BLOCKED by Phase-3 AUTO gate — ${phaseGate.reason}`);
        } else {
          const autoExec = hub.isAutoExecuteEnabled(autoExecDomain);
          if (autoExec.enabled) {
            try {
              // ── RISK GATE (RiskEngineV2 / RiskManager) ──
              // Never execute (even simulated) when risk limits are hit: global
              // drawdown cap, per-trade size cap, or kill-switch active. This wires
              // the previously-dead risk engine into the actual execution path.
              const riskCheck = hub.getRiskManager().isTradeAllowed(autoExec.maxTradeAmount || 0.1);
              if (!riskCheck.allowed) {
                console.warn(`[AUTO-EXECUTE] ${autoExecDomain} ${item.payload.symbol}: BLOCKED by risk gate — ${riskCheck.reason}`);
                globalOperationalHealth.recordAlert('RISK_WARNING', `Risk gate blocked ${item.payload.symbol}`, riskCheck.reason);
                await notifyControlRoom(activeClient, `risk:${autoExecDomain}`, `🚫 **RISK GATE BLOCKED** auto-execute ${autoExecDomain} ${item.payload.symbol}: ${riskCheck.reason}`);
                break;
              }
              if (globalRiskEngineV2.checkKillSwitchStatus()) {
                console.warn(`[AUTO-EXECUTE] ${autoExecDomain} ${item.payload.symbol}: BLOCKED — emergency kill-switch active.`);
                globalOperationalHealth.setKillSwitch(true, Date.now());
                globalOperationalHealth.recordAlert('RISK_WARNING', `Kill-switch active`, `${autoExecDomain} ${item.payload.symbol} blocked`);
                await notifyControlRoom(activeClient, 'risk:killswitch', `🚨 **KILL-SWITCH ACTIVE** — auto-execute ${autoExecDomain} ${item.payload.symbol} blocked.`);
                break;
              }
              if (autoExecDomain === 'meme-robinhood' && item.payload.contractAddress) {
                const execRes = await executeMemeBuy({
                  evm: evmTradeAdapter,
                  wallet: walletService,
                  journal: tradeJournalService,
                  onExecuted: () => stateStore.incrementFunnel('meme-robinhood', 'executed'),
                  chain: String(item.payload.network || 'robinhood'),
                  symbol: item.payload.symbol || 'TOKEN',
                  contractAddress: item.payload.contractAddress,
                  entryPriceUsd: parseFloat(String(item.payload.priceUsd || '0').replace(/[^0-9.]/g, '')) || 0,
                  amountEth: autoExec.maxTradeAmount || 0.1,
                  confidence: Number(item.payload.confidenceScore) || 0,
                  thesis: item.rawReason || item.payload.aiThesis || '',
                  strategyUsed: 'auto-execute',
                  safety: { isSafe: gateSafety },
                  txLock: gateTxLock(),
                  sizer: gateSizer(),
                  fillSim: gateFillSim(),
                  costGate: gateCostGate(),
                  governance: gateGovernance(),
                });
                console.log(`[AUTO-EXECUTE] meme-robinhood ${item.payload.symbol}: ${execRes.success ? (execRes.simulated ? 'SIMULATED ' : '') + 'ok' : 'FAILED'} ${execRes.error || ''} (out=${execRes.outputTokens})`);
              }
            } catch (err: any) { console.error(`[AUTO-EXECUTE] ${item.payload.symbol} error: ${err.message}`); }
          }
        }
      }

      // 1. Post to Discord Channel
      const targetChannel = activeClient?.channels?.cache?.find(
        (c: any) => c.type === ChannelType.GuildText && c.name === item.channelName
      ) as any;

      if (targetChannel && 'send' in targetChannel) {
        const embedData = buildCallEmbed(item.payload, { approvalOrderId });
        await targetChannel.send(embedData);
        console.log(`[DISCORD DISPATCH] Posted signal call card for "${item.payload.symbol}" to #${item.channelName}`);
      }

      // 2. Post to Telegram Topic
      if (telegramService.isEnabled()) {
        await telegramService.broadcastSignalCall(
          item.payload.title,
          item.payload.symbol,
          item.payload.contractAddress || 'N/A',
          item.rawReason,
          undefined,
          item.channelName
        );
        console.log(`[TELEGRAM DISPATCH] Broadcasted signal call for "${item.payload.symbol}" to topic: ${item.channelName}`);
      }

      // 3. Register called tokens for wallet auto-tracking (own-position detection + exit alerts)
                if (item.channelName === 'call-meme-robinhood' && item.payload.contractAddress) {
                  const chainForTracking = item.payload.network?.toLowerCase() === 'solana' ? 'sol' : 'robinhood';
                  walletTracker.registerTrackedToken(chainForTracking, item.payload.contractAddress, item.payload.symbol);
                }

      // 4. Feed the Swarm Learning Engine — every posted call is recorded at its
      //    entry price so outcome tracking (TP/SL via wallet-tracker) can
      //    recalibrate agent weights over time. (wired 2026-08-08)
      try {
        const { globalSwarmLearning } = await import('./orchestrator/swarm-learning.js');
        const entryPrice = parseFloat(String(item.payload.priceUsd || '0').replace(/[^0-9.]/g, '')) || 0;
        globalSwarmLearning.recordSignalCall(
          item.channelName.replace('call-', ''),
          item.payload.symbol || 'TOKEN',
          item.payload.contractAddress || item.payload.symbol || 'N/A',
          entryPrice,
          Number(item.payload.confidenceScore) || 0
        );
      } catch (learnErr: any) {
        console.warn(`[SWARM LEARNING] record failed: ${learnErr.message}`);
      }
    }

    // Opportunity Strategist: record the real approval outcome for every fired
    // signal, then decide which opportunities need a re-score and why now.
    // Fail-soft — never breaks the live loop.
    try {
      for (const { id, confidence } of firedOpportunities) {
        opportunityStrategist.recordDispatch(id, confidence);
      }
      const strategyCycle = opportunityStrategist.decide();
      const tally = new Map<string, number>();
      for (const d of strategyCycle.decisions) tally.set(d.action, (tally.get(d.action) || 0) + 1);
      if (tally.size > 0) {
        console.log(
          `[STRATEGIST] decisions=${JSON.stringify(Object.fromEntries(tally))} ` +
          `candidatesToScore=${strategyCycle.nextCandidates.length} readyToEnqueue=${strategyCycle.enqueueCandidates.length}`
        );
      }
      opportunityLedger.flushToDisk();
    } catch (strategistErr: any) {
      console.warn(`[STRATEGIST] cycle failed: ${strategistErr.message}`);
    }

    // Opportunity Post-mortem (build step 4): attribute terminal (closed)
    // opportunities that never got a finalOutcome and feed the outcome into
    // swarm-learning weight recalibration. Fail-soft — never breaks the loop.
    try {
      const pmResult = opportunityPostMortem.run();
      if (pmResult.attributedCount > 0) {
        console.log(
          `[POST-MORTEM] attributed=${pmResult.attributedCount} fedSuccess=${pmResult.fedSuccessCount} ` +
          `fedLoss=${pmResult.fedLossCount} neutral=${pmResult.skippedNeutralCount}`
        );
      }
      opportunityLedger.flushToDisk();
    } catch (pmErr: any) {
      console.warn(`[POST-MORTEM] cycle failed: ${pmErr.message}`);
    }

    // Wallet Auto-Tracking: detect user's own positions + exit alerts
    try {
      const alerts = await walletTracker.syncPositions();
      // PositionScanner: robinhood chain spot/LP positions (Robinhood Chain)
      const scannerAlerts = await positionScanner.scanAll();
      const allAlerts = [...alerts, ...scannerAlerts];
      if (allAlerts.length > 0) {
        for (const a of allAlerts) {
          globalOperationalHealth.recordAlert('POSITION_EXIT', `Position alert`, a.reason);
          await notifyControlRoom(activeClient, `position:${a.type}:${a.address}`, `🚨 **POSITION ALERT**\n${a.reason}`);
        }
      }
      console.log(`[POSITION MONITOR] ${positionManager.getActivePositions().length} spot + ${positionManager.getActiveLpPositions().length} LP + ${positionManager.getActiveNftPositions().length} NFT positions tracked, ${allAlerts.length} alert(s) fired this cycle.`);
    } catch (wtErr: any) {
      console.warn(`[POSITION MONITOR] sync failed this cycle: ${wtErr.message}`);
    }

    const currentFunnelSnapshot = globalOperationalHealth.snapshot().funnel;
    const nextOperationalFunnel = mergeOperationalFunnel(currentFunnelSnapshot, cycleOperationalFunnel);
    nextOperationalFunnel.positionsMonitored =
      positionManager.getActivePositions().length +
      positionManager.getActiveLpPositions().length +
      positionManager.getActiveNftPositions().length;
    globalOperationalHealth.setFunnel(nextOperationalFunnel);
    globalOperationalHealth.setSchedulerStatus({ name: 'screening', running: false, lastCompletedAt: Date.now() });

    // Phase-1 scorecard mark-to-market: refresh OPEN entries each cycle and flip TP/SL.
    try {
      const scorecardAdapter = new GMGNAdapter();
      const nowIso = new Date().toISOString();
      const chainMap: Record<string, 'sol' | 'bsc' | 'base' | 'eth' | 'robinhood'> = {
        solana: 'sol', sol: 'sol', bsc: 'bsc', 'bnb chain': 'bsc', base: 'base',
        ethereum: 'eth', robinhood: 'robinhood',
      };
      let openCount = 0;
      for (const entry of stateStore.getScorecard()) {
        if (entry.status !== 'OPEN' || !entry.contractAddress) continue;
        openCount += 1;
        const chain = chainMap[entry.chain] || 'robinhood';
        const info = await scorecardAdapter.fetchTokenInfo(chain, entry.contractAddress);
        if (info && info.priceUsd > 0) {
          stateStore.updateScorecardPrice(entry.id, info.priceUsd, nowIso);
        }
      }
      const scorecard = stateStore.getScorecard();
      const closed = scorecard.filter((e) => e.status !== 'OPEN');
      const wins = closed.filter((e) => e.status === 'TP').length;
      const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0;
      console.log(`[SCORECARD] open=${openCount} closed=${closed.length} tp=${wins} sl=${closed.length - wins} winRate=${winRate}%`);
    } catch (scErr: any) {
      console.warn(`[SCORECARD] mark-to-market failed this cycle: ${scErr.message}`);
    }
  } catch (err: any) {
    console.error('[SUB-AGENTS LOOP ERROR]', err.message);
    globalOperationalHealth.recordWorkerFailure('screening', err instanceof Error ? err.message : String(err));
    globalOperationalHealth.setSchedulerStatus({ name: 'screening', running: false, lastError: err instanceof Error ? err.message : String(err), lastCompletedAt: Date.now() });
    notifyControlRoom(activeClient, 'loop-error', `⚠️ **SCREENING LOOP ERROR**\n\`${err.message}\``);
  }
};

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
} else {
  console.log('[DISCORD BOT] DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID not set in .env. Running standalone engine.');
}

console.log('[SYSTEM] Setup complete. All OpenCatz modules ready.');
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
