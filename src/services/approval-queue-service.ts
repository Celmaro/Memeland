import { StateStore, type ApprovalOrder } from './state-store.js';
import { DecisionLedger, type TradeProposal } from './decision-ledger.js';
import { ApprovalOrderStateMachine } from '../lifecycle/state-machine.js';
import { confidenceToFraction } from './confidence.js';

export interface ApprovalOrderInput {
  domain: string;
  symbol: string;
  contractAddress: string;
  chain: string;
  entryPriceUsd: number;
  liquidityUsd?: number;
  suggestedSizeUsd: number;
  confidence: number;
  thesis: string;
}

export interface ApprovalStats {
  pending: number;
  approved: number;
  rejected: number;
  total: number;
}

export interface AutoGateResult {
  allowed: boolean;
  approvedFills: number;
  winRatePct: number;
  reason: string;
  /** P6.2 paper-regime gate (when provided): unlocked only across ≥N regimes. */
  paperRegimeGate?: { passed: boolean; coverage: Record<string, number>; expectancyPct: number; reason: string };
}

/** P6.2 paper-regime precondition handed to the AUTO gate (fail-closed). */
export interface PaperRegimePrecondition {
  passed: boolean;
  coverage: Record<string, number>;
  expectancyPct: number;
  reason: string;
}

/**
 * Phase-2 APPROVAL ladder (Arch 5). Gate-passed signals become PENDING orders an
 * operator one-click approves/cancels. Approved fills + positive scorecard
 * expectancy are what unlock Phase-3 AUTO — never the other way around.
 */
export class ApprovalQueueService {
  private stateStore: StateStore | null = null;
  private readonly ledger: DecisionLedger;

  /** Default floor for unlocking AUTO: N approved fills (Arch 5 / handoff §1). */
  private readonly minApprovedFills: number;

  constructor(opts: { minApprovedFills?: number; decisionLedger?: DecisionLedger } = {}) {
    this.minApprovedFills = opts.minApprovedFills ?? 50;
    this.ledger = opts.decisionLedger ?? new DecisionLedger();
  }

  public attachStateStore(store: StateStore): void {
    this.stateStore = store;
  }

  private requireStore(): StateStore {
    if (!this.stateStore) throw new Error('ApprovalQueueService: StateStore not attached');
    return this.stateStore;
  }

  /** Queue a gate-passed signal as a PENDING approval order. */
  public enqueue(input: ApprovalOrderInput, extra?: { scorecardId?: string }): ApprovalOrder {
    const store = this.requireStore();
    const order: ApprovalOrder = {
      id: `APR_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      domain: input.domain,
      symbol: input.symbol,
      contractAddress: input.contractAddress,
      chain: input.chain,
      entryPriceUsd: input.entryPriceUsd,
      liquidityUsd: input.liquidityUsd,
      suggestedSizeUsd: input.suggestedSizeUsd,
      confidence: input.confidence,
      thesis: input.thesis,
      status: 'PENDING',
      createdAtIso: new Date().toISOString(),
      scorecardId: extra?.scorecardId,
    };
    store.addApprovalOrder(order);
    return order;
  }

  public getById(id: string): ApprovalOrder | undefined {
    return this.requireStore().getApprovalOrder(id);
  }

  public listPending(): ApprovalOrder[] {
    return this.requireStore().getApprovalOrders().filter((o) => o.status === 'PENDING');
  }

  public getStats(): ApprovalStats {
    const orders = this.requireStore().getApprovalOrders();
    return {
      pending: orders.filter((o) => o.status === 'PENDING').length,
      approved: orders.filter((o) => o.status === 'APPROVED').length,
      rejected: orders.filter((o) => o.status === 'REJECTED').length,
      total: orders.length,
    };
  }

  /** Count of CONFIRMED (actually-executed) fills — the Phase-3 AUTO unlock
   *  numerator. Audit fix: this used to count APPROVED orders, so approvals
   *  that were blocked/failed still accrued toward the 50-fill floor. Only
   *  orders that reached CONFIRMED_FILL (fill executed + recorded) count. */
  public getApprovedFills(): number {
    return this.requireStore().getApprovalOrders().filter((o) => o.status === 'CONFIRMED_FILL').length;
  }

  /** Approve a pending order; no-op (returns null) if not PENDING. */
  public approve(id: string, decidedBy?: string): ApprovalOrder | null {
    const store = this.requireStore();
    const order = store.getApprovalOrder(id);
    if (!order) return null;
    // State machine owns the PENDING -> APPROVED/REJECTED edge (state-machine.ts).
    const sm = new ApprovalOrderStateMachine(order.status);
    if (!sm.canTransitionTo('APPROVED')) return null;
    order.status = sm.transitionTo('APPROVED');
    order.decidedAtIso = new Date().toISOString();
    order.decidedBy = decidedBy;
    store.updateApprovalOrder(order);
    store.incrementFunnel(order.domain, 'approved');
    const price = order.entryPriceUsd || 0;
    const proposal: TradeProposal = {
      agent: decidedBy || 'operator',
      nonce: order.id,
      symbol: order.symbol,
      chain: order.chain,
      side: 'BUY',
      sizeEth: price > 0 ? order.suggestedSizeUsd / price : 0,
      maxSizeEth: price > 0 ? order.suggestedSizeUsd / price : 0,
      confidence: confidenceToFraction(order.confidence || 0),
    };
    this.ledger.recordProposed(proposal);
    return order;
  }

  /** Reject/decline a pending order; no-op (returns null) if not PENDING. */
  public reject(id: string, decidedBy?: string): ApprovalOrder | null {
    const store = this.requireStore();
    const order = store.getApprovalOrder(id);
    if (!order) return null;
    // State machine owns the PENDING -> APPROVED/REJECTED edge (state-machine.ts).
    const sm = new ApprovalOrderStateMachine(order.status);
    if (!sm.canTransitionTo('REJECTED')) return null;
    order.status = sm.transitionTo('REJECTED');
    order.decidedAtIso = new Date().toISOString();
    order.decidedBy = decidedBy;
    store.updateApprovalOrder(order);
    store.incrementFunnel(order.domain, 'rejected');
    return order;
  }

  /** Bump the executed funnel stage AND confirm the fill — only call when the
   *  fill actually executed (audit fix: APPROVED alone must not unlock Phase-3
   *  AUTO; only confirmed, executed fills count toward the floor). */
  public recordExecuted(id: string): void {
    const store = this.requireStore();
    const order = store.getApprovalOrder(id);
    if (!order) return;
    store.incrementFunnel(order.domain, 'executed');
    // APPROVED -> CONFIRMED_FILL (terminal) once the fill runs. Fail-safe: if
    // the order already reached a terminal state, leave it (never downgrade).
    if (order.status === 'APPROVED') {
      const sm = new ApprovalOrderStateMachine(order.status);
      if (sm.canTransitionTo('CONFIRMED_FILL')) {
        order.status = sm.transitionTo('CONFIRMED_FILL');
        store.updateApprovalOrder(order);
      }
    }
  }

  /**
   * Phase-3 AUTO gate: unlocked ONLY when approved fills reach the floor AND
   * the scorecard shows positive expectancy (win rate > 50% on closed entries)
   * AND the P6.2 paper-regime precondition passes (when provided).
   * Fail-closed: no approved fills / no closed entries → not allowed.
   */
  public canAutoExecute(scorecardClosed: { tp: number; sl: number }, paperGate?: PaperRegimePrecondition): AutoGateResult {
    const approvedFills = this.getApprovedFills();
    const closed = scorecardClosed.tp + scorecardClosed.sl;
    const winRatePct = closed > 0 ? Math.round((scorecardClosed.tp / closed) * 100) : 0;

    const fillLocked = approvedFills < this.minApprovedFills;
    const noExpectancy = closed === 0 || winRatePct <= 50;
    // P6.2: when a paper-regime precondition is supplied, it is CONJUNCTIVE
    // with the fill floor + expectancy — the paper ledger must prove several
    // regimes before AUTO can open. Absent gate → treated as passed (callers
    // that don't run paper trading keep their current behavior).
    const paperRegimeGate: PaperRegimePrecondition = paperGate ?? {
      passed: true,
      coverage: {},
      expectancyPct: 0,
      reason: 'paper-regime gate not configured',
    };

    if (fillLocked || noExpectancy || !paperRegimeGate.passed) {
      const reasons: string[] = [];
      if (fillLocked) reasons.push(`approved fills ${approvedFills}/${this.minApprovedFills}`);
      if (noExpectancy) reasons.push(`expectancy not proven (${closed === 0 ? 'no closed entries' : `winRate ${winRatePct}%`})`);
      if (!paperRegimeGate.passed) reasons.push(`paper regimes not proven (${paperRegimeGate.reason})`);
      return {
        allowed: false,
        approvedFills,
        winRatePct,
        paperRegimeGate,
        reason: `AUTO locked — ${reasons.join('; ')}`,
      };
    }

    return {
      allowed: true,
      approvedFills,
      winRatePct,
      paperRegimeGate,
      reason: `AUTO unlocked (${approvedFills} approved fills, ${winRatePct}% win rate, paper regimes proven)`,
    };
  }
}

export const globalApprovalQueueService = new ApprovalQueueService();
