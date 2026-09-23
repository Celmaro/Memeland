/**
 * Kernel S — Screening cycle factory (extracted verbatim from index.ts).
 *
 * The live production loop: heartbeats → equity/drawdown → market regime →
 * dispatch → consensus gate → funnel → dedup → approval ladder → auto-exec →
 * Discord/Telegram dispatch → wallet tracking → scorecard mark-to-market.
 *
 * G7 discipline: this is a byte-for-byte move of the former inline closure
 * (index.ts:247-646). Deps are injected as a single object; mutable closure
 * state (prevPortfolioEquityUsd, recentSignals hydration) is owned here or
 * passed by reference. `getActiveClient` is a getter because the Discord
 * client is assigned after the factory runs.
 */

import { isAutoExecute, isSignalOnly } from '../config/config.js';
import { globalRiskEngineV2 } from '../orchestrator/risk-engine-v2.js';
import { globalDecisionCache } from '../services/decision-cache.js';
import { sellabilityConfigured } from '../services/execution-gates.js';

/**
 * Dependency surface of the screening cycle. Typed `any` deliberately: the
 * contract is "index.ts wires the live singletons", and the loop body was
 * moved verbatim — narrowing types here is a follow-up, not part of the move.
 */
export interface ScreeningCycleDeps {
  hub: any;
  globalHealthWatcher: any;
  globalWalletBalanceReader: any;
  priceFeedService: any;
  stateStore: any;
  globalMarketRegimeFilter: any;
  dispatchDomain: any;
  robinhoodScreeningAgent: any;
  whaleScreeningAgent: any;
  apiKeyGuard: any;
  gateSignal: (payload: any) => boolean;
  createOperationalFunnel: any;
  mergeOperationalFunnel: any;
  globalOperationalHealth: any;
  DEDUP_WINDOW_MS: number;
  sightingFromCallCard: (item: any) => any;
  opportunityStrategist: any;
  opportunityLedger: any;
  approvalQueueService: any;
  executeMemeBuy: any;
  evmTradeAdapter: any;
  walletService: any;
  tradeJournalService: any;
  gateSafety: any;
  gateTxLock: any;
  gateSizer: any;
  gateFillSim: any;
  gateCostGate: any;
  gateGovernance: any;
  gateSellability: any;
  globalLifiExecutor: any;
  globalDecisionLedger: any;
  normalizeExecutionChainKey: any;
  executableChainsFromEnv: any;
  buildCallEmbed: any;
  telegramService: any;
  /** Getter — the Discord client is assigned after factory creation. */
  getActiveClient: () => any;
  walletTracker: any;
  positionManager: any;
  globalReputationMemory: any;
  GMGNAdapter: any;
  notifyControlRoom: (client: any, key: string, content: string) => Promise<void>;
  opportunityPostMortem: any;
  ChannelType: any;
  SCREENING_TIMEOUT_MS: number;
  withScreeningTimeout: <T>(promise: Promise<T>, domain: string, timeoutMs: number) => Promise<T>;
}

export function createScreeningCycle(deps: ScreeningCycleDeps): () => Promise<void> {
  const {
    hub, globalHealthWatcher, globalWalletBalanceReader, priceFeedService, stateStore,
    globalMarketRegimeFilter, dispatchDomain, robinhoodScreeningAgent, whaleScreeningAgent,
    apiKeyGuard, gateSignal, createOperationalFunnel, mergeOperationalFunnel,
    globalOperationalHealth, DEDUP_WINDOW_MS, sightingFromCallCard,
    opportunityStrategist, opportunityLedger, approvalQueueService, executeMemeBuy,
    evmTradeAdapter, walletService, tradeJournalService, gateSafety, gateTxLock, gateSizer,
    gateFillSim, gateCostGate, gateGovernance, gateSellability, globalLifiExecutor,
    globalDecisionLedger, normalizeExecutionChainKey, executableChainsFromEnv, buildCallEmbed,
    telegramService, getActiveClient, walletTracker, positionManager, globalReputationMemory,
    GMGNAdapter, notifyControlRoom, opportunityPostMortem, ChannelType,
    SCREENING_TIMEOUT_MS, withScreeningTimeout,
  } = deps;

  // Real portfolio equity tracker (feeds RiskManager drawdown). Owned here —
  // the old index.ts declaration was only ever read/written inside the loop.
  let prevPortfolioEquityUsd: number | null = null;

  return async () => {

  const cycleOperationalFunnel = createOperationalFunnel();
  globalOperationalHealth.setSchedulerStatus({ name: 'screening', running: true, lastStartedAt: Date.now() });
  globalOperationalHealth.recordProviderRequest('screening-pass', true);
  // Memeland fork: print the actual chain list being scanned this cycle so the
  // operator can confirm the env override (MULTICHAIN_CHAINS) is in effect.
  const memeChains = (robinhoodScreeningAgent as unknown as { chains?: string[] }).chains ?? [];
  console.log(`[SCREENING CYCLE] tick=${Date.now()} domains=${hub.getActiveDomains().join('+') || 'none'} meme.chains=${memeChains.join('+') || '(see [FUNNEL] line)'}`);
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
      const ethBal = await globalWalletBalanceReader.getEvmBalance();
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

    let dispatchedPayloads: Array<{ payload: import('../agents/shared/agent-contract.js').CallCardPayload; channelName: string; rawReason: string }> = [];

            const robinhoodDispatched = await dispatchDomain({
              domain: 'meme-robinhood',
              channelName: 'call-meme-robinhood',
              isActive: () => hub.isAgentActive('meme-robinhood'),
              runPass: () => withScreeningTimeout(robinhoodScreeningAgent.runScreeningPass(), 'meme-robinhood', SCREENING_TIMEOUT_MS),
              keyReady: () => apiKeyGuard.checkDomainKeys('meme-robinhood'),
            });
            dispatchedPayloads.push(...robinhoodDispatched);

            const whaleDispatched = await dispatchDomain({
              domain: 'whale-eth',
              channelName: 'call-whale-eth',
              isActive: () => hub.isAgentActive('whale-eth'),
              runPass: () => withScreeningTimeout(whaleScreeningAgent.runScreeningPass(), 'whale-eth', SCREENING_TIMEOUT_MS),
              keyReady: () => apiKeyGuard.checkDomainKeys('whale-eth'),
            });
            dispatchedPayloads.push(...whaleDispatched);

    // Real Swarm Consensus gate (>= 80%): every signal must pass with real data
    const preGateCount = dispatchedPayloads.length;
    dispatchedPayloads = dispatchedPayloads.filter((item) => gateSignal(item.payload));
    const postGateCount = dispatchedPayloads.length;
    const memeStats = robinhoodScreeningAgent.getLastFunnelStats();
    const whaleStats = whaleScreeningAgent.getLastFunnelStats?.() ?? { scanned: 0, prefiltered: 0, emitted: 0 };
    stateStore.incrementFunnel('meme-robinhood', 'scanned', memeStats.scanned);
    stateStore.incrementFunnel('meme-robinhood', 'consensus', postGateCount);
    cycleOperationalFunnel.sourcesQueried += Math.max(1, hub.getActiveDomains().length);
    cycleOperationalFunnel.candidatesDiscovered += memeStats.scanned;
    cycleOperationalFunnel.candidatesNormalized += memeStats.prefiltered;
    cycleOperationalFunnel.candidatesEnriched += preGateCount;
    cycleOperationalFunnel.candidatesRejectedByGate += Math.max(0, preGateCount - postGateCount);
    cycleOperationalFunnel.signalsEmitted += postGateCount;
    // Fix #4: include the meme agent's own upstream counters (scan/prefilter/emit)
    // in the same line so `beforeGate=0 afterGate=0` is no longer ambiguous —
    // if memeStats.prefiltered=0, every reader of the log can see "prefilter
    // is the upstream dead end" without running the 7-bucket checklist in their head.
    console.log(`[FUNNEL] cycle: agents=${hub.getActiveDomains().join('+')} meme.scan=${memeStats.scanned} meme.prefilter=${memeStats.prefiltered} meme.emit=${memeStats.emitted} whale.scan=${whaleStats.scanned} whale.emit=${whaleStats.emitted} beforeGate=${preGateCount} afterGate=${postGateCount} (cumulative: ${JSON.stringify(stateStore.getFunnelStats()['meme-robinhood'] || {})})`);

    // Register real heartbeats for every active agent that ran this pass
    for (const domain of hub.getActiveDomains()) {
      globalHealthWatcher.recordHeartbeat(domain);
    }


    // Phase-3 AUTO gate expectancy source: TP/SL counts from the live scorecard.
    const scorecardExpectancy = () => {
      const closed = stateStore.getScorecard().filter((e: any) => e.status !== 'OPEN');
      return {
        tp: closed.filter((e: any) => e.status === 'TP').length,
        sl: closed.filter((e: any) => e.status === 'SL').length,
      };
    };

    // Dispatch all passed signals to Discord channels & Telegram topics (with dedup)
    const now = Date.now();
    const firedOpportunities: Array<{ id: string; confidence: number }> = [];
    for (const item of dispatchedPayloads) {
      const dedupKey = `${item.channelName}:${item.payload.symbol}:${item.payload.contractAddress || 'N/A'}`;
      // Kernel F sticky TTL owns the in-memory dedup now (quick win): a hit
      // returns the stored old timestamp (skip); a miss stores + returns `now`.
      const seenAt = await globalDecisionCache.getSticky<number>(dedupKey, () => now, { ttlMs: DEDUP_WINDOW_MS });
      if (seenAt !== null && seenAt !== now) {
        console.log(`[DEDUP] Skipping duplicate signal: ${dedupKey} (posted ${((now - seenAt) / 60000).toFixed(0)}m ago)`);
        continue;
      }
      stateStore.setDedupEntry(dedupKey, now);
      globalOperationalHealth.recordAlert(
        'CONSENSUS_PASS',
        `Consensus pass: ${item.payload.symbol}`,
        `${item.channelName} confidence ${Number(item.payload.confidenceScore) || 0}%`
      );

      // Opportunity ledger: ingest every fired signal so the Strategist can
      // re-score/re-admit it over time. Never gates anything (fail-soft).
      try {
        const sighting = sightingFromCallCard(item);
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
      // Multi-chain execution: resolve the signal's chain from the payload and
      // only admit chains that are in the executable registry. Unknown chains
      // fail closed — they never reach the approval ladder.
      const signalChainKey = normalizeExecutionChainKey(String(item.payload.network || 'robinhood')) ?? 'robinhood';
      const signalExecutable = executableChainsFromEnv().has(signalChainKey);
      const autoExecDomain = signalExecutable ? `meme-${signalChainKey}` : undefined;
      if (signalExecutable && item.payload.contractAddress) {
        const queuedPrice = parseFloat(String(item.payload.priceUsd || '0').replace(/[^0-9.]/g, '')) || 0;
        const order = approvalQueueService.enqueue(
          {
            domain: autoExecDomain || 'meme-robinhood',
            symbol: item.payload.symbol || 'TOKEN',
            contractAddress: item.payload.contractAddress,
            chain: signalChainKey,
            entryPriceUsd: queuedPrice,
            suggestedSizeUsd: (hub.isAutoExecuteEnabled(autoExecDomain || 'meme-robinhood').maxTradeAmount || 0.1) * (queuedPrice || 1),
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
              // ── RISK GATE (single authority: RiskEngineV2 → RiskManager + kill-switch) ──
              // Gemini G-3 fix: one gate consults the risk-manager limits AND the
              // kill-switch, preserving the exact precedence of the two separate
              // calls this replaces (risk-manager first, then kill-switch).
              const riskGate = globalRiskEngineV2.checkExecutionAllowed(autoExec.maxTradeAmount || 0.1, hub.getRiskManager());
              if (!riskGate.allowed) {
                const isKill = riskGate.source === 'kill-switch';
                console.warn(`[AUTO-EXECUTE] ${autoExecDomain} ${item.payload.symbol}: BLOCKED by risk gate — ${riskGate.reason}`);
                globalOperationalHealth.recordAlert('RISK_WARNING', isKill ? 'Kill-switch active' : `Risk gate blocked ${item.payload.symbol}`, riskGate.reason);
                if (isKill) globalOperationalHealth.setKillSwitch(true, Date.now());
                await notifyControlRoom(
                  getActiveClient(),
                  isKill ? 'risk:killswitch' : `risk:${autoExecDomain}`,
                  isKill
                    ? `🚨 **KILL-SWITCH ACTIVE** — auto-execute ${autoExecDomain} ${item.payload.symbol} blocked.`
                    : `🚫 **RISK GATE BLOCKED** auto-execute ${autoExecDomain} ${item.payload.symbol}: ${riskGate.reason}`,
                );
                break;
              }
              if (autoExecDomain && item.payload.contractAddress) {
                const execRes = await executeMemeBuy({
                  evm: evmTradeAdapter,
                  wallet: walletService,
                  journal: tradeJournalService,
                  onExecuted: () => stateStore.incrementFunnel(autoExecDomain, 'executed'),
                  executor: globalLifiExecutor,
                  chain: signalChainKey,
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
                  sellability: sellabilityConfigured() ? gateSellability() : undefined,
                  fillSim: gateFillSim(),
                  costGate: gateCostGate(),
                  governance: gateGovernance(),
                  ledger: globalDecisionLedger,
                });
                console.log(`[AUTO-EXECUTE] ${autoExecDomain} ${item.payload.symbol}: ${execRes.success ? (execRes.simulated ? 'SIMULATED ' : '') + 'ok' : 'FAILED'} ${execRes.error || ''} (out=${execRes.outputTokens})`);
              }
            } catch (err: any) { console.error(`[AUTO-EXECUTE] ${item.payload.symbol} error: ${err.message}`); }
          }
        }
      }

      // 1. Post to Discord Channel
      const targetChannel = getActiveClient()?.channels?.cache?.find(
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
                  const chainForTracking = normalizeExecutionChainKey(String(item.payload.network || 'robinhood')) ?? 'robinhood';
                  walletTracker.registerTrackedToken(chainForTracking, item.payload.contractAddress, item.payload.symbol);
                }

      // 4. Feed the Swarm Learning Engine — every posted call is recorded at its
      //    entry price so outcome tracking (TP/SL via wallet-tracker) can
      //    recalibrate agent weights over time. (wired 2026-08-08)
      try {
        const { globalSwarmLearning } = await import('../orchestrator/swarm-learning.js');
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
      if (alerts.length > 0) {
        for (const a of alerts) {
          globalOperationalHealth.recordAlert('POSITION_EXIT', `Position alert`, a.reason);
          await notifyControlRoom(getActiveClient(), `position:${a.type}:${a.address}`, `🚨 **POSITION ALERT**\n${a.reason}`);
        }
      }
      console.log(`[POSITION MONITOR] ${positionManager.getActivePositions().length} spot positions tracked, ${alerts.length} alert(s) fired this cycle.`);
    } catch (wtErr: any) {
      console.warn(`[POSITION MONITOR] sync failed this cycle: ${wtErr.message}`);
    }

    const currentFunnelSnapshot = globalOperationalHealth.snapshot().funnel;
    const nextOperationalFunnel = mergeOperationalFunnel(currentFunnelSnapshot, cycleOperationalFunnel);
    nextOperationalFunnel.positionsMonitored =
      positionManager.getActivePositions().length;
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
      const closed = scorecard.filter((e: any) => e.status !== 'OPEN');
      const wins = closed.filter((e: any) => e.status === 'TP').length;
      const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0;
      // Kernel A: write terminal follow-up labels from the live scorecard.
      try {
        for (const entry of closed) {
          if (!entry.contractAddress) continue;
          const followUp = entry.status === 'TP' ? 'live' : entry.status === 'SL' ? 'rugged' : 'abandoned';
          globalReputationMemory.labelAfterFollowup(entry.contractAddress, followUp);
        }
        globalReputationMemory.flush();
      } catch (repErr: any) {
        console.warn(`[REPUTATION MEMORY] scorecard write failed: ${repErr.message}`);
      }
      console.log(`[SCORECARD] open=${openCount} closed=${closed.length} tp=${wins} sl=${closed.length - wins} winRate=${winRate}%`);
    } catch (scErr: any) {
      console.warn(`[SCORECARD] mark-to-market failed this cycle: ${scErr.message}`);
    }
  } catch (err: any) {
    console.error('[SUB-AGENTS LOOP ERROR]', err.message);
    globalOperationalHealth.recordWorkerFailure('screening', err instanceof Error ? err.message : String(err));
    globalOperationalHealth.setSchedulerStatus({ name: 'screening', running: false, lastError: err instanceof Error ? err.message : String(err), lastCompletedAt: Date.now() });
    notifyControlRoom(getActiveClient(), 'loop-error', `⚠️ **SCREENING LOOP ERROR**\n\`${err.message}\``);
  }
  };
}
