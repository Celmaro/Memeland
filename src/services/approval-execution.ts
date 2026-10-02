/**
 * Phase-2/3 execution helper — the one place a meme buy (auto-execute OR
 * one-click operator approve) turns into an EVM buy + trade-journal OPEN entry
 * + executed funnel bump. Kept dependency-injected so it stays unit-testable
 * without live network/RPC and so both call sites stay identical.
 */
import type { EVMTradeAdapter } from '../adapters/evm-adapter.js';
import type { WalletService } from './wallet-service.js';
import type { TradeJournalService } from './trade-journal-service.js';
import { DecisionLedger, type TradeProposal, type TradePlan, type TradeLifecycleState } from './decision-ledger.js';
import { confidenceToFraction } from './confidence.js';
import { EXECUTION_CHAIN_KEYS, normalizeExecutionChainKey } from '../config/execution-registry.js';

export interface ExecuteMemeBuyOptions {
  evm: EVMTradeAdapter;
  wallet: WalletService;
  journal: TradeJournalService;
  /** Called after the fill is recorded — bumps the `executed` funnel stage. */
  onExecuted: () => void;
  /** Signal chain (payload.network / approval order chain). Defaults to robinhood. */
  chain?: string;
  symbol: string;
  contractAddress: string;
  entryPriceUsd: number;
  /** Real pooled liquidity of the target token (from the candidate). The
   *  fill-sim gate uses this for impact, NOT entryPriceUsd*1000 (audit finding:
   *  the synthetic liquidity over/under-stated real pool depth and made the
   *  impact proof meaningless). When absent, the fill-sim fails closed. */
  liquidityUsd?: number;
  /** CANONICAL order size in USD notional (NOT an ETH amount). This is the one
   *  quantity used by risk, sizer, fill-sim, cost, governance, LI.FI and the
   *  journal. Native-coin amount is derived only at the raw-EVM adapter edge.
   *  (Audit fix: previously `amountEth * entryPriceUsd` produced fake USD.) */
  amountUsd: number;
  confidence: number;
  thesis: string;
  /** Journal strategy label — AUTO gate vs one-click operator approve differ. */
  strategyUsed?: string;
  /** Q15 fail-closed safe-config gate. When provided and NOT safe, the fill is refused. */
  safety?: { isSafe(): { safe: boolean; reason: string } };
  /** Quoter-honeypot sellability proof (rh-execution-core). When provided and NOT sellable, refused. */
  sellability?: { check(tokenAddress: string): Promise<{ sellable: boolean; reason: string }> };
  /** Per-token tx serializer (rh-execution-core TxLock). When provided, only one in-flight tx per token. */
  txLock?: { acquire(tokenAddress: string): Promise<() => void> };
  /** Q07 multi-constraint sizer. When provided, clamps the notional to the binding
   *  constraint using confidence + real pooled liquidity; refuses on refusal. */
  sizer?: { clamp(desiredUsd: number, ctx?: { confidence?: number; liquidityUsd?: number }): { allowed: boolean; amountUsd: number; reason?: string } };
  /** Q08 fill simulation. When provided, refuses fills whose impact is refused / over a cap. */
  fillSim?: { check(input: { amountUsd: number; midPriceUsd: number; liquidityUsd?: number }): { allowed: boolean; impactPct: number; reason?: string } };
  /** Q13 cost/notional gate. When provided, a fill must be within the cumulative
   *  notional cap. NOTE: it is charged the executed notional (`effectiveUsd`). */
  costGate?: { trySpend(costUsd: number): { allowed: boolean; reason?: string } };
  /** Q11 execution governance. When provided, the order is reserved + receipt-locked before the fill. */
  governance?: { reserve(order: { nonce: string; payload: string }): { reserved: boolean; reason?: string }; issue(order: { nonce: string; payload: string }): { valid: boolean; reason?: string } };
  /** Q09 executor-DI. When provided, the buy is routed through this executor instead of the raw EVM adapter. */
  executor?: { submit(req: { chain: string; token: string; side: 'buy'; amountUsd: number; timeoutMs?: number }): Promise<{ outcome: 'confirmed' | 'failed' | 'timed_out' | 'simulated'; txHash?: string; reason?: string; at: number }> };
  /** Decision ledger audit hook: proposal + send reconciliation for the shared fill path. */
  ledger?: DecisionLedger;
}

export interface ExecuteMemeBuyResult {
  success: boolean;
  simulated: boolean;
  outputTokens: number;
  error?: string;
}

/** Chains with a live execution adapter (every registered LI.FI chain). All others fail closed. */
const EXECUTABLE_CHAINS = new Set<string>(EXECUTION_CHAIN_KEYS);

/** Normalize payload/approval chain labels to the canonical chain key. */
export function normalizeChain(v: string): string {
  const k = normalizeExecutionChainKey(v) ?? String(v || '').trim().toLowerCase();
  return k;
}

export async function executeMemeBuy(opts: ExecuteMemeBuyOptions): Promise<ExecuteMemeBuyResult> {
  const chain = normalizeChain(opts.chain || 'robinhood');
  if (!EXECUTABLE_CHAINS.has(chain)) {
    return {
      success: false,
      simulated: false,
      outputTokens: 0,
      error: `no execution adapter for chain '${chain}' — fail-closed (LI.FI multi-chain registry)`,
    };
  }

  const nonce = `${opts.contractAddress}:${opts.symbol}:${Date.now()}`;
  const proposal: TradeProposal = {
    agent: opts.strategyUsed || 'auto-execute',
    nonce,
    symbol: opts.symbol,
    chain,
    side: 'BUY',
    sizeEth: opts.amountUsd,
    maxSizeEth: opts.amountUsd,
    sizeUsd: opts.amountUsd,
    maxSizeUsd: opts.amountUsd,
    confidence: confidenceToFraction(opts.confidence || 0),
  };
  opts.ledger?.recordProposed(proposal);

  // ── Item 1: explicit trade-plan + lifecycle state machine ──────────────
  // Agents propose plans; the deterministic gates below are the ONLY promotion
  // path. Every transition is recorded (planned → approved → simulated →
  // submitted → confirmed | rejected/failed/timed_out) for reconciliation.
  const plan: TradePlan = {
    agent: proposal.agent,
    nonce,
    symbol: opts.symbol || 'TOKEN',
    chain,
    side: 'BUY',
    tokenAddress: opts.contractAddress || '',
    amountUsd: opts.amountUsd,
    maxAmountUsd: opts.amountUsd,
    quoteUsd: opts.amountUsd,
    slippageTolerancePct: 1.5,
    confidence: proposal.confidence,
    timestamp: new Date().toISOString(),
    lifecycle: 'planned',
  };
  const lifecycle = (state: TradeLifecycleState, extra?: { reason?: string; txHash?: string }) =>
    opts.ledger?.recordLifecycle({ ...plan, lifecycle: state }, state, extra);

  const reject = (state: 'rejected' | 'failed' | 'timed_out', reason: string): ExecuteMemeBuyResult => {
    lifecycle(state, { reason });
    return { success: false, simulated: false, outputTokens: 0, error: reason };
  };

  lifecycle('planned');

  // ── Q15 fail-closed safety gate ─────────────────────────────────────────
  // When a safe-config registry is injected, an explicit-safe config must be
  // in force or the fill is refused (read-only default; remediate to enable).
  if (opts.safety) {
    const s = opts.safety.isSafe();
    if (!s.safe) return reject('rejected', `safety gate refused: ${s.reason}`);
  } else {
    console.warn('[EXEC] no safety gate injected — fills proceed unguarded (tests / unconfigured only)');
  }

  // ── Quoter-honeypot sellability proof (fail-closed) ─────────────────────
  if (opts.sellability) {
    const s = await opts.sellability.check(opts.contractAddress);
    if (!s.sellable) return reject('rejected', `sellability gate refused: ${s.reason}`);
  }

  // ── Q07 multi-constraint sizing (USD notional clamp) ────────────────────
  // Canonical USD notional. The sizer's output (NOT the input) is what the
  // fill-sim / cost / governance / LI.FI / journal all consume downstream —
  // otherwise the gates wouldn't guard the amount actually submitted.
  const desiredUsd = opts.amountUsd;
  // P1-4: feed the sizer the confidence + liquidity context it needs. Before this,
  // the Q07 gateSizer defaulted confidence/liquidity to 0, producing a 0.5×0.5
  // scale and silently sizing to ~25% of the requested notional.
  const sized = opts.sizer
    ? opts.sizer.clamp(desiredUsd, { confidence: opts.confidence, liquidityUsd: opts.liquidityUsd })
    : { allowed: true, amountUsd: desiredUsd };
  if (!sized.allowed) return reject('rejected', `sizing gate refused: ${sized.reason}`);
  const effectiveUsd = sized.amountUsd > 0 ? sized.amountUsd : desiredUsd;
  // Legacy raw-EVM branch only: derive the adapter's input units from the sized
  // notional at the token price. LI.FI never sees this — it gets effectiveUsd.
  const effectiveAmountEth = opts.entryPriceUsd > 0 ? effectiveUsd / opts.entryPriceUsd : effectiveUsd;

  // ── Q08 fill simulation (impact / liquidity proof, fail-closed) ─────────
  lifecycle('approved'); // non-sim approval gates passed (safety/sellability/sizer)
  if (opts.fillSim) {
    // Audit fix: use REAL pool liquidity, not entryPriceUsd*1000 (which was
    // price-proportional fiction). Fail closed when the real depth is unknown —
    // a fill whose impact can't be proven against actual liquidity is refused.
    if (opts.liquidityUsd === undefined || opts.liquidityUsd <= 0) {
      return reject('rejected', `fill-sim gate refused: unknown pool liquidity (fail-closed).`);
    }
    const s = opts.fillSim.check({ amountUsd: effectiveUsd, midPriceUsd: opts.entryPriceUsd, liquidityUsd: opts.liquidityUsd });
    if (!s.allowed) return reject('rejected', `fill-sim gate refused: ${s.reason} (impact ${s.impactPct.toFixed(1)}%)`);
  }
  lifecycle('simulated');

  // ── Q13 cost/notional gate (charged the EXECUTED notional, i.e. effectiveUsd,
  //    NOT an estimated fee — see cost-gating.ts for the semantics) ──────────
  if (opts.costGate) {
    const c = opts.costGate.trySpend(effectiveUsd);
    if (!c.allowed) return reject('rejected', `cost gate refused: ${c.reason}`);
  }

  // ── Q11 execution governance (idempotent reservation + hash-locked receipt) ──
  if (opts.governance) {
    const payload = JSON.stringify({ chain, token: opts.contractAddress, amountUsd: effectiveUsd });
    const reserved = opts.governance.reserve({ nonce, payload });
    if (!reserved.reserved) return reject('rejected', `governance reservation refused: ${reserved.reason}`);
    const receipt = opts.governance.issue({ nonce, payload });
    if (!receipt.valid) return reject('rejected', `governance receipt refused: ${receipt.reason}`);
  }

  // ── Per-token tx serialization (TxLock) ─────────────────────────────────
  const release = opts.txLock ? await opts.txLock.acquire(opts.contractAddress) : null;
  try {
    lifecycle('submitted');
    // Q09 executor-DI: when an executor is provided, route the fill through it
    // (serialized + veto-with-reason) instead of the raw EVM adapter.
    const execRes = opts.executor
      ? await (async () => {
          const r = await opts.executor!.submit({
            chain,
            token: opts.contractAddress,
            side: 'buy',
            amountUsd: effectiveUsd,
            timeoutMs: 15_000,
          });
          return {
            success: r.outcome === 'confirmed' || r.outcome === 'simulated',
            simulated: r.outcome === 'simulated',
            outputTokens: 0,
            txHash: r.txHash,
            error: r.outcome === 'confirmed' || r.outcome === 'simulated' ? undefined : (r.reason || r.outcome),
          };
        })()
      : await opts.evm.executeBuyToken(
          {
            chain,
            tokenAddress: opts.contractAddress,
            amountEth: effectiveAmountEth,
            slippagePercentage: 1.5,
          },
          opts.wallet
        );

    const finalState: TradeLifecycleState = execRes.success ? 'confirmed' : (execRes.error?.includes('timed out') || execRes.error?.includes('timeout') ? 'timed_out' : 'failed');
    lifecycle(finalState, { reason: execRes.error, txHash: (execRes as { txHash?: string }).txHash });

    const journalEntry = opts.journal.recordTradeEntry({
      id: `TRADE_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      domain: 'MEME_ROBINHOOD',
      symbol: opts.symbol || 'TOKEN',
      contractAddressOrId: opts.contractAddress || opts.symbol || 'N/A',
      chain,
      entryTimestamp: new Date().toISOString(),
      entryPriceUsdOrEth: opts.entryPriceUsd,
      positionSizeUsd: effectiveUsd,
      swarmScore: opts.confidence,
      strategyUsed: opts.strategyUsed || 'approval-approved',
      aiThesisSummary: (opts.thesis || '').slice(0, 200),
      status: 'OPEN',
      nonce,
      lifecycle: finalState,
      txHash: (execRes as { txHash?: string }).txHash,
      quoteUsd: effectiveUsd,
      expectedOutTokens: undefined,
      failureReason: execRes.error,
    });
    void journalEntry;

    // Audit fix (#10): onExecuted fires ONLY on a confirmed fill, never on
    // failure — a failed/timed-out fill must not bump the `executed` counter
    // nor (via recordExecuted) mark the approval order CONFIRMED_FILL.
    if (execRes.success) {
      opts.onExecuted();
    }
    opts.ledger?.recordSend(nonce, execRes.success ? 'confirmed' : 'failed');
    return {
      success: execRes.success,
      simulated: execRes.simulated,
      outputTokens: execRes.outputTokens,
      error: execRes.error,
    };
  } finally {
    release?.();
  }
}
