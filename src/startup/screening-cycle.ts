/**
 * Kernel S — Screening cycle factory (extracted verbatim from index.ts).
 *
 * The live production loop: heartbeats → equity/drawdown → dispatch → consensus
 * gate → funnel → dedup → approval ladder → auto-exec → Discord/Telegram dispatch
 * → wallet tracking → scorecard mark-to-market.
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
import { globalWalletGraph } from '../graph/wallet-graph.js';
import { globalRPCFailoverManager } from '../services/rpc-failover.js';
import { globalProviderGovernor } from '../services/provider-governor.js';
import { sellabilityConfigured } from '../services/execution-gates.js';
import type { PaperTradingLedger } from '../services/paper-trading.js';
import { bookFromMid } from '../services/paper-trading.js';
import { globalPassReceiptLedger, type PassReceipt } from '../services/pass-receipt.js';
import { PassTracer } from '../telemetry/trace-log.js';

/** Cycle cadence (default 5 min) — used by the stale-gate hours calculation. */
const CYCLE_INTERVAL_MS = 5 * 60 * 1000;
/** #6: consecutive afterGate=0 cycles — the automated "fired=0 ⇒ diagnostic" norm. */
let staleGateCycles = 0;
/** Streak length at which the message is re-worded as a long streak (≈1h at 5-min). */
const STALE_GATE_ESCALATE_AFTER = 12;

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
  dispatchDomain: any;
  robinhoodScreeningAgent: any;
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
  /** P6.2 paper-trading ledger (mid-market fills + regime-coverage gate). */
  paperTrading?: PaperTradingLedger | null;
  /** P6.2 gate threshold env: regimes, per-regime trades, expectancy floor. */
  paperMinRegimes?: number;
  paperMinPerRegime?: number;
  paperMinExpectancyPct?: number;
  GMGNAdapter: any;
  notifyControlRoom: (client: any, key: string, content: string) => Promise<void>;
  opportunityPostMortem: any;
  ChannelType: any;
  SCREENING_TIMEOUT_MS: number;
  withScreeningTimeout: <T>(promise: Promise<T>, domain: string, timeoutMs: number, log?: (msg: string) => void, controller?: AbortController) => Promise<T>;
}

export function createScreeningCycle(deps: ScreeningCycleDeps): () => Promise<void> {
  const {
    hub, globalHealthWatcher, globalWalletBalanceReader, priceFeedService, stateStore,
    dispatchDomain, robinhoodScreeningAgent,
    apiKeyGuard, gateSignal, createOperationalFunnel, mergeOperationalFunnel,
    globalOperationalHealth, DEDUP_WINDOW_MS, sightingFromCallCard,
    opportunityStrategist, opportunityLedger, approvalQueueService, executeMemeBuy,
    evmTradeAdapter, walletService, tradeJournalService, gateSafety, gateTxLock, gateSizer,
    gateFillSim, gateCostGate, gateGovernance, gateSellability, globalLifiExecutor,
    globalDecisionLedger, normalizeExecutionChainKey, executableChainsFromEnv, buildCallEmbed,
    telegramService, getActiveClient, walletTracker, positionManager, globalReputationMemory,
    paperTrading, paperMinRegimes, paperMinPerRegime, paperMinExpectancyPct,
    GMGNAdapter, notifyControlRoom, opportunityPostMortem, ChannelType,
    SCREENING_TIMEOUT_MS, withScreeningTimeout,
  } = deps;

  // Real portfolio equity tracker (feeds RiskManager drawdown). Owned here —
  // the old index.ts declaration was only ever read/written inside the loop.
  let prevPortfolioEquityUsd: number | null = null;

  return async () => {
  const tracer = new PassTracer();
  const cycleOperationalFunnel = createOperationalFunnel();
  globalOperationalHealth.setSchedulerStatus({ name: 'screening', running: true, lastStartedAt: Date.now() });
  globalOperationalHealth.recordProviderRequest('screening-pass', true);
  // Refresh RPC failover pools periodically (5-min throttle): pick the fastest
  // verified host per chain before this pass makes on-chain reads/broadcasts.
  try {
    if (Date.now() - globalRPCFailoverManager.getLastProbeAt() > 5 * 60_000) {
      void globalRPCFailoverManager.probeLatencies()
        .then(() => {
          // A7: log the active host per chain so the operator sees failover
          // actually working (which host won, per pool) without scraping probes.
          const active = (['rh', 'eth', 'bsc', 'base', 'sol'] as const)
            .map((k) => {
              const url = globalRPCFailoverManager.getActiveRPC(k);
              const short = url.replace(/^https?:\/\//, '').split('/')[0] || url;
              return `${k}=${short}`;
            })
            .join(' ');
          console.log(`[RPC FAILOVER] active hosts: ${active}`);
          // T1 — cross-RPC block-lag verification (opt-in, fail-open): when
          // RPC_LAG_VERIFY=true, compare the latest block height across the
          // chain's healthy hosts and quarantine any that lag. Extra block
          // reads are skipped by default to avoid doubling probe traffic.
          if (process.env.RPC_LAG_VERIFY === 'true') {
            for (const k of ['rh', 'eth', 'bsc', 'base', 'sol'] as const) {
              void globalRPCFailoverManager.runBlockLagVerification(k).catch(() => {});
            }
          }
        })
        .catch((err: any) =>
          console.warn(`[RPC FAILOVER] latency probe failed: ${err.message}`));
    }
  } catch (err: any) {
    console.warn(`[RPC FAILOVER] probe scheduling failed: ${err.message}`);
  }
  // D1/D2 — aggregate discovery spend surface: per-provider governor budget, so
  // the operator sees fabric-wide paid-feed spend (and any hard-freeze) at a
  // glance. Single control surface across solanatracker/fomo/arkham.
  try {
    const spend = globalProviderGovernor.stats();
    const ids = Object.keys(spend);
    if (ids.length > 0) {
      const line = ids
        .map((id) => `${id}=${spend[id].spent}${spend[id].frozenMs > 0 ? `(frozen ${Math.round(spend[id].frozenMs / 60000)}m)` : ''}`)
        .join(' ');
      console.log(`[DISCOVERY SPEND] ${line}`);
    }
  } catch { /* spend telemetry never blocks a cycle */ }
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

    let dispatchedPayloads: Array<{ payload: import('../agents/shared/agent-contract.js').CallCardPayload; channelName: string; rawReason: string }> = [];

            const robinhoodDispatched = await dispatchDomain({
              domain: 'meme-robinhood',
              channelName: 'call-meme-robinhood',
              isActive: () => hub.isAgentActive('meme-robinhood'),
              runPass: () => {
                // P2-1: a per-pass AbortController lets the timeout primitive
                // cancel underlying work. runScreeningPass is not yet signal-aware,
                // but the controller is wired so an abort-aware pass cancels upstream.
                const passController = new AbortController();
                return withScreeningTimeout(
                  robinhoodScreeningAgent.runScreeningPass(passController.signal),
                  'meme-robinhood',
                  SCREENING_TIMEOUT_MS,
                  (msg) => console.warn(msg),
                  passController,
                );
              },
              keyReady: () => apiKeyGuard.checkDomainKeys('meme-robinhood'),
            });
            dispatchedPayloads.push(...robinhoodDispatched);

    // Real Swarm Consensus gate (>= 80%): every signal must pass with real data
    const preGateCount = dispatchedPayloads.length;
    dispatchedPayloads = dispatchedPayloads.filter((item) => gateSignal(item.payload));
    const postGateCount = dispatchedPayloads.length;
    const memeStats = robinhoodScreeningAgent.getLastFunnelStats();
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
    console.log(`[FUNNEL] cycle: agents=${hub.getActiveDomains().join('+')} meme.scan=${memeStats.scanned} meme.prefilter=${memeStats.prefiltered} meme.emit=${memeStats.emitted} beforeGate=${preGateCount} afterGate=${postGateCount} (cumulative: ${JSON.stringify(stateStore.getFunnelStats()['meme-robinhood'] || {})})`);

    // 6.1 — immutable per-pass audit receipt: "did the bot fire" becomes a
    // queryable record, not a log-grep. Fail-open (the sink never throws).
    tracer.info('pass.end', {
      domains: hub.getActiveDomains(),
      chains: memeChains,
      scanned: memeStats.scanned,
      prefiltered: memeStats.prefiltered,
      beforeGate: preGateCount,
      afterGate: postGateCount,
      fired: dispatchedPayloads.length,
    });
    try {
      const receipt: PassReceipt = {
        at: new Date().toISOString(),
        domains: hub.getActiveDomains(),
        chains: memeChains,
        candidateCountBySource: { discovery: memeStats.scanned },
        candidatesNormalized: memeStats.prefiltered,
        gate: {
          beforeGate: preGateCount,
          afterGate: postGateCount,
          rejectedByGate: Math.max(0, preGateCount - postGateCount),
          fired: dispatchedPayloads.map((d) => d.channelName),
        },
      };
      globalPassReceiptLedger.record(receipt);
    } catch (receiptErr: any) {
      console.warn(`[PASS RECEIPT] write failed (non-fatal): ${receiptErr.message}`);
    }

    // #6 stale-gate detector: sustained afterGate=0 is the "fired=0 across
    // deploys ⇒ diagnostic report, not another patch" norm automated. Logs on
    // EVERY zero-gate cycle: the previous `% STALE_GATE_AFTER` modulo meant a
    // silently non-firing bot was invisible in any log window shorter than ~1h,
    // which is exactly what happened during the 2026-09-29 Zeabur audit — the
    // funnel counters had to be read to notice a 5,957-scan / 0-fire streak.
    // The counter still escalates the message once the streak is long.
    staleGateCycles = postGateCount > 0 ? 0 : staleGateCycles + 1;
    if (postGateCount === 0 && staleGateCycles > 0) {
      const hours = (staleGateCycles * CYCLE_INTERVAL_MS / 60000 / 60).toFixed(1);
      const tag = staleGateCycles >= STALE_GATE_ESCALATE_AFTER ? 'STALE GATE (long streak)' : 'STALE GATE';
      // E1/I-1 — distinguish WHY afterGate=0 so the "not firing" alert is honest:
      //   emit=0                  → the funnel never produced signals (upstream dead)
      //   emit>0 → beforeGate>0 → afterGate=0 → consensus/selector gate rejecting
      let cause: string;
      if (memeStats.emitted === 0) {
        cause = `emit=0 (funnel dead — scan=${memeStats.scanned}, prefilter=${memeStats.prefiltered}). Diagnose upstream enriching/screening.`;
      } else if (preGateCount > 0 && postGateCount === 0) {
        cause = `gate rejecting: emit=${memeStats.emitted}→beforeGate=${preGateCount}→afterGate=0. See [CONSENSUS GATE] lines above for per-signal stats.`;
      } else {
        cause = `gate selected 0 of ${preGateCount} signals.`;
      }
      console.warn(
        `[${tag}] afterGate=0 for ${staleGateCycles} consecutive cycle(s) (${hours}h) — ${cause} ` +
          'Diagnose before adding features.',
      );
    }

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
    // Execution Mode check: AUTO_EXECUTE executes live trades, DRY_RUN simulates
    // with real market quotes, SIGNAL_ONLY skips trade execution. Declared here
    // (before the dispatch loop) so paper trading and the AUTO gate share one flag.
    const AUTO_EXECUTE_ENABLED = isAutoExecute() || process.env.AUTO_EXECUTE_ENABLED === 'true';
    const firedOpportunities: Array<{ id: string; confidence: number }> = [];
    // P0.4 (B#instrument) — ONE consolidated end-to-end funnel counter per cycle.
    // Every stage from discovery to execution is tallied in one place so "why are
    // there no steady trades?" is answerable from a SINGLE log line instead of a
    // seven-bucket checklist spread across five subsystems. Deliberately separate
    // from the existing [FUNNEL] line, which stays the stable parse contract.
    const e2e = {
      discovered: memeStats.scanned,
      prefilter: memeStats.prefiltered,
      signalPass: memeStats.emitted,
      consensusPass: postGateCount,
      dedupSkip: 0,
      fired: 0,
      scorecard: 0,
      paperOpen: 0,
      approvalQueued: 0,
      autoGateBlocked: 0,
      autoDisabled: 0,
      riskBlocked: 0,
      execAttempted: 0,
      execOk: 0,
    };
    for (const item of dispatchedPayloads) {
      const dedupKey = `${item.channelName}:${item.payload.symbol}:${item.payload.contractAddress || 'N/A'}`;
      // Kernel F sticky TTL owns the in-memory dedup now (quick win): a hit
      // returns the stored old timestamp (skip); a miss stores + returns `now`.
      const seenAt = await globalDecisionCache.getSticky<number>(dedupKey, () => now, { ttlMs: DEDUP_WINDOW_MS });
      if (seenAt !== null && seenAt !== now) {
        console.log(`[DEDUP] Skipping duplicate signal: ${dedupKey} (posted ${((now - seenAt) / 60000).toFixed(0)}m ago)`);
        e2e.dedupSkip += 1;
        continue;
      }
      e2e.fired += 1;
      stateStore.setDedupEntry(dedupKey, now);
      globalOperationalHealth.recordAlert(
        'CONSENSUS_PASS',
        `Consensus pass: ${item.payload.symbol}`,
        `${item.channelName} confidence ${Number(item.payload.confidenceScore) || 0}%`
      );

      // Opportunity ledger: ingest every fired signal so the Strategist can
      // re-score/re-admit it over time. Never gates anything (fail-soft).
      // #3 lineage: capture the opportunityId and thread it into the scorecard
      // so decision↔scorecard↔position↔outcome trace as one chain.
      let opportunityId: string | undefined;
      try {
        const sighting = sightingFromCallCard(item);
        if (sighting) {
          opportunityId = opportunityStrategist.ingest(sighting).opportunityId;
          if (opportunityId) {
            firedOpportunities.push({
              id: opportunityId,
              confidence: Number(item.payload.confidenceScore) || 0,
            });
          }
        }
      } catch (ledgerErr: any) {
        console.warn(`[OPPORTUNITY LEDGER] ingest failed (${item.payload.symbol}): ${ledgerErr.message}`);
      }

      // Phase-1 scorecard + funnel: this signal FIRED — open a predicted-vs-actual entry
      stateStore.incrementFunnel('meme-robinhood', 'fired');
      let scorecardId: string | undefined;
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
            opportunityId,
          });
          console.log(`[LINEAGE] ${item.payload.symbol}: opportunity=${opportunityId ?? 'n/a'} scorecard=${scorecardId} → decision chain linked`);
          e2e.scorecard += 1;
      }

      // P6.2 paper trading: open a mid-market paper position for every fired
      // signal while in DRY_RUN (never live). The two-sided book is modeled
      // from the REAL mid + REAL pooled depth via the splash model; when depth
      // is unknown the open fails closed (no paper fill without a proofable
      // book). The paper position closes when the scorecard flips TP/SL, and
      // the regime-coverage gate (≥N regimes × positive expectancy) is what
      // later unlocks Phase-3 AUTO.
      if (paperTrading && !AUTO_EXECUTE_ENABLED && firedPrice > 0) {
        // P0.2 — regime is now a first-class, typed field on the call card
        // (populated from the real detection path), so no cast is needed and a
        // missing regime means "undetected" rather than an unchecked string.
        const paperRegime = item.payload.regime;
        const paperBook = bookFromMid(firedPrice, item.payload.liquidityUsd, 10);
        if (paperBook === null) {
          console.log(`[PAPER] ${item.payload.symbol}: open refused — no proofable two-sided book (depth=${item.payload.liquidityUsd ?? 'unknown'})`);
        } else {
          const paperOpen = paperTrading.openTrade({
            symbol: item.payload.symbol || 'TOKEN',
            chain: String(item.payload.network || 'robinhood').toLowerCase(),
            contractAddress: item.payload.contractAddress || '',
            book: paperBook,
            liquidityUsd: item.payload.liquidityUsd,
            sizeUsd: 10,
            confidence: Number(item.payload.confidenceScore) || 0,
            regime: paperRegime,
            strategyUsed: 'paper-screening',
            thesis: item.rawReason || item.payload.aiThesis || '',
            scorecardId,
          });
          if (paperOpen.ok) {
            console.log(`[PAPER] opened ${paperOpen.trade!.id} ${item.payload.symbol} @ ${paperOpen.trade!.entryFillPriceUsd.toFixed(6)} (slip ${paperOpen.trade!.slipPct.toFixed(2)}%) regime=${paperRegime ?? 'none'}`);
            e2e.paperOpen += 1;
          } else {
            console.log(`[PAPER] ${item.payload.symbol}: open refused — ${paperOpen.reason}`);
          }
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
      // P1-6: will THIS signal be handled by the AUTO path? If so it must NOT be
      // advertised as a human-pending approval (no misleading APPROVAL_REQUIRED,
      // and its order is reconciled to executed/failed rather than left PENDING).
      const domainAutoOn =
        AUTO_EXECUTE_ENABLED &&
        !isSignalOnly() &&
        !!autoExecDomain &&
        hub.isAutoExecuteEnabled(autoExecDomain).enabled;
      if (signalExecutable && item.payload.contractAddress) {
        const queuedPrice = parseFloat(String(item.payload.priceUsd || '0').replace(/[^0-9.]/g, '')) || 0;
        const order = approvalQueueService.enqueue(
          {
            domain: autoExecDomain || 'meme-robinhood',
            symbol: item.payload.symbol || 'TOKEN',
            contractAddress: item.payload.contractAddress,
            chain: signalChainKey,
            entryPriceUsd: queuedPrice,
            liquidityUsd: item.payload.liquidityUsd,
            // P0: maxTradeAmount is USD notional — do NOT scale by token price.
            suggestedSizeUsd: hub.isAutoExecuteEnabled(autoExecDomain || 'meme-robinhood').maxTradeAmount || 0.1,
            confidence: Number(item.payload.confidenceScore) || 0,
            thesis: (item.rawReason || item.payload.aiThesis || '').slice(0, 300),
          },
          { scorecardId }
        );
        approvalOrderId = order.id;
        console.log(`[APPROVAL] Queued PENDING order ${order.id} for ${item.payload.symbol} (scorecard ${scorecardId || 'n/a'})`);
        e2e.approvalQueued += 1;
        if (!domainAutoOn) {
          globalOperationalHealth.recordAlert('APPROVAL_REQUIRED', `Approval required: ${item.payload.symbol}`, `order ${order.id}`);
        }
      }

      // Execution Mode check: AUTO_EXECUTE executes live trades, DRY_RUN simulates with real market quotes, SIGNAL_ONLY skips trade execution.
      if (autoExecDomain && AUTO_EXECUTE_ENABLED && !isSignalOnly()) {
        // Phase-3 AUTO gate: execution only opens once the approved-fill floor
        // (N > 50) AND positive expectancy (closed win rate > 50%) AND the
        // P6.2 paper-regime precondition (several regimes × positive paper
        // expectancy) are proven.
        // P6.2: the paper ledger unlocks AUTO only after ≥N regimes each with
        // ≥M closed paper trades at positive expectancy — fail-closed.
        const paperGate = paperTrading
          ? paperTrading.unlockStatus({
              minRegimes: paperMinRegimes ?? 3,
              minPerRegime: paperMinPerRegime ?? 5,
              minExpectancyPct: paperMinExpectancyPct ?? 0,
            })
          : undefined;
        const phaseGate = approvalQueueService.canAutoExecute(scorecardExpectancy(), paperGate);
        if (!phaseGate.allowed) {
          console.warn(`[AUTO-EXECUTE] ${autoExecDomain} ${item.payload.symbol}: BLOCKED by Phase-3 AUTO gate — ${phaseGate.reason}`);
          e2e.autoGateBlocked += 1;
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
                // P0.1 (B#5): a per-token risk rejection must NOT abort the whole
                // batch. Only a global kill-switch stops the loop; any other risk
                // block just skips ONWARD to the next candidate.
                if (isKill) {
                  e2e.riskBlocked += 1;
                  break;
                }
                e2e.riskBlocked += 1;
                continue;
              }
              if (autoExecDomain && item.payload.contractAddress) {
                e2e.execAttempted += 1;
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
                  liquidityUsd: item.payload.liquidityUsd,
                  amountUsd: autoExec.maxTradeAmount || 0.1,
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
                if (execRes.success) e2e.execOk += 1;
                // P1-6: an auto-executed order must NOT linger as human-pending. Mark
                // it executed/failed so the approval queue and APP approval counts stay
                // truthful instead of accumulating stale PENDING rows.
                if (approvalOrderId) {
                  if (execRes.success) approvalQueueService.recordExecuted(approvalOrderId);
                  else approvalQueueService.recordFailed(approvalOrderId);
                }
              }
            } catch (err: any) {
              console.error(`[AUTO-EXECUTE] ${item.payload.symbol} error: ${err.message}`);
              if (approvalOrderId) approvalQueueService.recordFailed(approvalOrderId);
            }
          } else {
            // The Phase-3 gate OPENED but this domain's AUTO toggle is off — a
            // distinct dead-end from autoGateBlocked, so it gets its own column.
            e2e.autoDisabled += 1;
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

    // P0.4 — the single end-to-end funnel line. Read left to right it IS the
    // pipeline; the FIRST stage that collapses to 0 while later stages expect
    // >0 is the bottleneck. `dedupSkip` and `fired` should sum to consensusPass.
    console.log(
      `[E2E FUNNEL] discovered=${e2e.discovered} prefilter=${e2e.prefilter} ` +
      `signal80=${e2e.signalPass} consensus80=${e2e.consensusPass} ` +
      `dedup=${e2e.dedupSkip} fired=${e2e.fired} scorecard=${e2e.scorecard} ` +
      `paper=${e2e.paperOpen} approval=${e2e.approvalQueued} ` +
      `autoGateBlock=${e2e.autoGateBlocked} autoOff=${e2e.autoDisabled} ` +
      `riskBlock=${e2e.riskBlocked} execTry=${e2e.execAttempted} execOk=${e2e.execOk}`
    );

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

      // P1.3 — RE-FEED the strategist's enqueueCandidates into the real approval
      // ladder. They were previously computed every cycle and then DISCARDED
      // (counted in a log line only), so every opportunity the strategist
      // escalated to READY_SMALL_BET sat there forever — a whole escalation
      // ladder that could never produce an actionable order. Each is resolved
      // back to (chain, contract, price) and enqueued exactly like a freshly
      // fired signal, then marked ENQUEUE in the ledger so it cannot double-fire.
      let strategistEnqueued = 0;
      let strategistUnresolvable = 0;
      // P1-10: re-feed with a FRESH execution snapshot. Previously the strategist
      // enqueued `liquidityUsd: undefined, confidence: 0` from stale ledger
      // metadata; with the fail-closed fill simulator that order was manufactured
      // non-executable (READY_SMALL_BET escalations could never be filled). Fetch
      // current price + liquidity from GMGN and only enqueue when we have real
      // liquidity proof — otherwise treat as unresolvable rather than queueing a
      // dead order. Fail-soft: a fetch error never throws out of the loop.
      const strategistGmgn = new GMGNAdapter();
      for (const id of strategyCycle.enqueueCandidates) {
        try {
          const resolved = opportunityStrategist.resolveForEnqueue(id);
          if (!resolved) { strategistUnresolvable += 1; continue; }
          const chainKey = normalizeExecutionChainKey(resolved.chain) ?? 'robinhood';
          if (!executableChainsFromEnv().has(chainKey)) { strategistUnresolvable += 1; continue; }

          let fresh: any = null;
          try {
            fresh = await strategistGmgn.fetchTokenInfo(chainKey as any, resolved.contractAddress);
          } catch (snapErr: any) {
            console.warn(`[STRATEGIST] fresh snapshot failed for ${id}: ${snapErr.message}`);
          }
          const freshLiq = Number(fresh?.liquidityUsd);
          if (!Number.isFinite(freshLiq) || freshLiq <= 0) {
            // No current liquidity proof -> do NOT manufacture an executable-looking
            // order. Leave it for the next strategist cycle to re-score.
            strategistUnresolvable += 1;
            continue;
          }
          const freshPrice = Number(fresh?.priceUsd);
          const price = Number.isFinite(freshPrice) && freshPrice > 0 ? freshPrice : (Number(resolved.priceUsd) || 0);

          const order = approvalQueueService.enqueue({
            domain: `meme-${chainKey}`,
            symbol: resolved.symbol || fresh?.symbol || 'TOKEN',
            contractAddress: resolved.contractAddress,
            chain: chainKey,
            entryPriceUsd: price,
            liquidityUsd: freshLiq,
            // P0: maxTradeAmount is USD notional — do NOT scale by token price.
            suggestedSizeUsd: hub.isAutoExecuteEnabled(`meme-${chainKey}`).maxTradeAmount || 0.1,
            // Strategist escalation carries no swarm consensus; a deliberate sub-80
            // confidence keeps the Q07 sizer scaling modestly instead of to its floor.
            confidence: 70,
            thesis: `Strategist escalation ${id} -> READY_SMALL_BET (fresh liq $${freshLiq.toFixed(0)})`,
          });
          if (opportunityStrategist.enqueue(id)) {
            strategistEnqueued += 1;
            console.log(`[STRATEGIST] re-fed ${id} ${resolved.symbol || ''} into approval as ${order.id} (chain=${chainKey} liq=$${freshLiq.toFixed(0)})`);
          }
        } catch (refeedErr: any) {
          console.warn(`[STRATEGIST] re-feed failed for ${id}: ${refeedErr.message}`);
        }
      }

      if (tally.size > 0) {
        console.log(
          `[STRATEGIST] decisions=${JSON.stringify(Object.fromEntries(tally))} ` +
          `candidatesToScore=${strategyCycle.nextCandidates.length} readyToEnqueue=${strategyCycle.enqueueCandidates.length} ` +
          `reFed=${strategistEnqueued} unresolvable=${strategistUnresolvable}`
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
          // P6.2 paper trading: a scorecard TP/SL flip closes the mirroring
          // paper position at the same price → realized outcome for the
          // regime-coverage gate and the walk-forward OOS harness.
          if (entry.status === 'TP') {
            const closed = paperTrading?.closeByScorecard(entry.id, info.priceUsd, 'CLOSED_TP');
            if (closed?.ok) console.log(`[PAPER] closed ${entry.symbol} TP @ ${info.priceUsd} (pnl ${closed.pnlPct!.toFixed(1)}%)`);
          } else if (entry.status === 'SL') {
            const closed = paperTrading?.closeByScorecard(entry.id, info.priceUsd, 'CLOSED_SL');
            if (closed?.ok) console.log(`[PAPER] closed ${entry.symbol} SL @ ${info.priceUsd} (pnl ${closed.pnlPct!.toFixed(1)}%)`);
          }
        }
      }
      const scorecard = stateStore.getScorecard();
      const closed = scorecard.filter((e: any) => e.status !== 'OPEN');
      const wins = closed.filter((e: any) => e.status === 'TP').length;
      const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : 0;
      // Kernel A: write terminal follow-up labels from the live scorecard.
      // #4 wallet-graph: also feed deployer outcomes (TP=success, SL=rug) so
      // the bot accumulates deployer reputation / rug-rate over time.
      try {
        for (const entry of closed) {
          if (!entry.contractAddress) continue;
          const followUp = entry.status === 'TP' ? 'live' : entry.status === 'SL' ? 'rugged' : 'abandoned';
          globalReputationMemory.labelAfterFollowup(entry.contractAddress, followUp);
          if (entry.status === 'TP') {
            globalWalletGraph.recordDeployerOutcome(entry.contractAddress, 'success');
            console.log(`[WALLET GRAPH] ${entry.symbol} deployer ${entry.contractAddress.slice(0, 6)}… → success call`);
          } else if (entry.status === 'SL') {
            globalWalletGraph.recordDeployerOutcome(entry.contractAddress, 'rug');
            console.log(`[WALLET GRAPH] ${entry.symbol} deployer ${entry.contractAddress.slice(0, 6)}… → rug outcome`);
          }
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
