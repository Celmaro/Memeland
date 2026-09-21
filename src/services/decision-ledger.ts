/**
 * PR 1 / Kernel C — Decision Ledger (SRC-154 tradingcodex, SRC-107 NERVE,
 * SRC-261 FLYWHEEL, SRC-262 grok-trading-desk, Million append-only audit).
 *
 * The single, append-only writer for the execute pipeline's proposal -> veto ->
 * reservation -> receipt -> reconcile state machine. Composes the existing Q11
 * ApprovalGovernance (idempotent reservation + hash-locked receipt + deny-first
 * RBAC) with:
 *   - propose-vs-decide split + six-checks resulting-weight sizing (FLYWHEEL),
 *   - exactly-once reconcile-by-nonce with a 'replaced' guard (NERVE),
 *   - fail-closed veto + pessimistic fallback helpers (grok).
 *
 * Additive-only: no existing signature changes. Persistence is injected (io.append)
 * so the module stays pure/testable and never touches a live executor or secrets.
 */

import { ApprovalGovernance, type ApprovalOrder } from './exec-governance.js';

export type ReconcileState = 'confirmed' | 'failed' | 'unknown' | 'replaced';
export type SendOutcome = 'confirmed' | 'failed';

export interface RiskCheck {
  id: string;
  label: string;
  passed: boolean;
  observed: number;
  limit: number;
}

export interface TradeProposal {
  agent: string;
  nonce: string;
  symbol: string;
  chain: string;
  side: 'BUY' | 'SELL';
  sizeEth: number;
  maxSizeEth: number;
  confidence: number;
  liquidityUsd?: number;
}

export interface WeightResult {
  weight: number;
  checks: RiskCheck[];
  reason?: string;
}

export interface LedgerEvent {
  kind: 'proposed' | 'veto' | 'reserved' | 'receipt_issued' | 'receipt_rejected' | 'send' | 'replaced';
  seq: number;
  nonce?: string;
  agent?: string;
  symbol?: string;
  chain?: string;
  outcome?: SendOutcome;
  reason?: string;
}

export interface DecisionLedgerIO {
  /** Append one JSON line for an event. Implementations own atomicity/rotation. */
  append(line: string): void;
}

export interface DecisionLedgerOptions {
  now?: () => number;
  io?: DecisionLedgerIO;
  checks?: {
    confFloor?: number;
    chainSet?: string[];
    minLiquidityUsd?: number;
    maxLiquidityUsd?: number;
  };
}

const DEFAULT_CHAINS = ['robinhood', 'sol', 'eth', 'bsc', 'base'];

export class DecisionLedger {
  private readonly gov: ApprovalGovernance;
  private readonly io?: DecisionLedgerIO;
  private readonly checks: Required<NonNullable<DecisionLedgerOptions['checks']>>;
  private seq = 0;
  private events: LedgerEvent[] = [];
  private readonly sends = new Map<string, ReconcileState>();

  constructor(opts: DecisionLedgerOptions = {}) {
    this.gov = new ApprovalGovernance(opts.now);
    this.io = opts.io;
    this.checks = {
      confFloor: opts.checks?.confFloor ?? 0.5,
      chainSet: opts.checks?.chainSet ?? DEFAULT_CHAINS,
      minLiquidityUsd: opts.checks?.minLiquidityUsd ?? 1_000,
      maxLiquidityUsd: opts.checks?.maxLiquidityUsd ?? 100_000_000,
    };
  }

  get audit(): readonly LedgerEvent[] {
    return this.events;
  }

  private emit(ev: Omit<LedgerEvent, 'seq'>): number {
    const seq = ++this.seq;
    const full: LedgerEvent = { ...ev, seq };
    this.events.push(full);
    this.io?.append(JSON.stringify(full));
    return seq;
  }

  /** Idempotent reservation. Same nonce/payload is a no-op; different payload refused. */
  reserve(order: ApprovalOrder): { reserved: boolean; reason?: string; at: number } {
    const r = this.gov.reserve(order);
    if (r.reserved) this.emit({ kind: 'reserved', nonce: order.nonce });
    return r;
  }

  /** Hash-locked receipt — only valid when the payload matches the reservation. */
  issueReceipt(order: ApprovalOrder): { valid: boolean; reason?: string } {
    const r = this.gov.issueReceipt(order);
    this.emit({
      kind: r.valid ? 'receipt_issued' : 'receipt_rejected',
      nonce: order.nonce,
      reason: r.reason,
    });
    return { valid: r.valid, reason: r.reason };
  }

  /** Append a propose (decide) event to the ledger. Returns its sequence. */
  recordProposed(proposal: TradeProposal): number {
    return this.emit({
      kind: 'proposed',
      nonce: proposal.nonce,
      agent: proposal.agent,
      symbol: proposal.symbol,
      chain: proposal.chain,
    });
  }

  /** Append a veto to the ledger. Returns its sequence. */
  recordVeto(reason: string, payload: unknown): number {
    const agent = (payload as { agent?: string } | null)?.agent;
    return this.emit({ kind: 'veto', reason, agent });
  }

  /**
   * Record a settled send outcome exactly once. A second, different outcome for the
   * same nonce is refused and flags the earlier settlement as 'replaced'.
   */
  recordSend(nonce: string, outcome: SendOutcome): { recorded: boolean; state: ReconcileState } {
    const existing = this.sends.get(nonce);
    if (existing) {
      if (existing === outcome) return { recorded: false, state: existing };
      this.sends.set(nonce, 'replaced');
      this.emit({ kind: 'replaced', nonce });
      return { recorded: false, state: 'replaced' };
    }
    this.sends.set(nonce, outcome);
    this.emit({ kind: 'send', nonce, outcome });
    return { recorded: true, state: outcome };
  }

  /** Recovery CLI for unknown terminal states: settled -> confirmed/failed, else unknown. */
  reconcileByNonce(nonce: string): ReconcileState {
    return this.sends.get(nonce) ?? 'unknown';
  }

  /** FLYWHEEL six-checks gate. All pass -> weight = confidence; any fail -> fail-closed 0. */
  resultingWeight(proposal: TradeProposal): WeightResult {
    const chainOk = this.checks.chainSet.includes(proposal.chain);
    const measured = typeof proposal.liquidityUsd === 'number';
    const liq = proposal.liquidityUsd ?? 0;
    const checks: RiskCheck[] = [
      {
        id: 'size',
        label: 'order size within max',
        passed: proposal.sizeEth <= proposal.maxSizeEth,
        observed: proposal.sizeEth,
        limit: proposal.maxSizeEth,
      },
      {
        id: 'confidence',
        label: 'confidence at or above floor',
        passed: proposal.confidence >= this.checks.confFloor,
        observed: proposal.confidence,
        limit: this.checks.confFloor,
      },
      {
        id: 'chain',
        label: 'chain is supported',
        passed: chainOk,
        observed: chainOk ? 1 : 0,
        limit: 1,
      },
      {
        id: 'liquidity_min',
        label: 'liquidity above lower band',
        passed: !measured || liq >= this.checks.minLiquidityUsd,
        observed: liq,
        limit: this.checks.minLiquidityUsd,
      },
      {
        id: 'liquidity_max',
        label: 'liquidity within upper band',
        passed: !measured || liq <= this.checks.maxLiquidityUsd,
        observed: liq,
        limit: this.checks.maxLiquidityUsd,
      },
      {
        id: 'side',
        label: 'buy-only sizing',
        passed: proposal.side === 'BUY',
        observed: proposal.side === 'BUY' ? 1 : 0,
        limit: 1,
      },
    ];
    const failed = checks.find((c) => !c.passed);
    if (failed) {
      return { weight: 0, checks, reason: `${failed.id}: ${failed.label}` };
    }
    return { weight: Math.min(1, Math.max(0, proposal.confidence)), checks };
  }

  /** grok: when a model output cannot be parsed, veto with a named reason. */
  vetoOnParseFailure(agent: string, _raw: string): { veto: true; reason: string } {
    const reason = `parse failure: no trustworthy verdict from '${agent}'`;
    this.recordVeto(reason, { agent });
    return { veto: true, reason };
  }

  /** grok: pessimistic fallback — hold when the pipeline is broken, else buy. */
  pessimisticFallback(_agent: string, broken: boolean): 'HOLD' | 'BUY' {
    return broken ? 'HOLD' : 'BUY';
  }
}

/** Live-process audit ledger used by the shared execution/AUTO path. */
export const globalDecisionLedger = new DecisionLedger();
