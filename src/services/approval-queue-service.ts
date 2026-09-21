import { StateStore, type ApprovalOrder } from './state-store.js';
import { DecisionLedger, type TradeProposal } from './decision-ledger.js';
import { ApprovalOrderStateMachine } from '../lifecycle/state-machine.js';

export interface ApprovalOrderInput {
  domain: string;
  symbol: string;
  contractAddress: string;
  chain: string;
  entryPriceUsd: number;
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

  /** Count of APPROVED fills — the Phase-3 AUTO unlock numerator. */
  public getApprovedFills(): number {
    return this.requireStore().getApprovalOrders().filter((o) => o.status === 'APPROVED').length;
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
      confidence: (order.confidence || 0) / 100,
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

  /** Bump the executed funnel stage for an approved order once the fill runs. */
  public recordExecuted(id: string): void {
    const store = this.requireStore();
    const order = store.getApprovalOrder(id);
    if (!order) return;
    store.incrementFunnel(order.domain, 'executed');
  }

  /**
   * Phase-3 AUTO gate: unlocked ONLY when approved fills reach the floor AND
   * the scorecard shows positive expectancy (win rate > 50% on closed entries).
   * Fail-closed: no approved fills / no closed entries → not allowed.
   */
  public canAutoExecute(scorecardClosed: { tp: number; sl: number }): AutoGateResult {
    const approvedFills = this.getApprovedFills();
    const closed = scorecardClosed.tp + scorecardClosed.sl;
    const winRatePct = closed > 0 ? Math.round((scorecardClosed.tp / closed) * 100) : 0;

    const fillLocked = approvedFills < this.minApprovedFills;
    const noExpectancy = closed === 0 || winRatePct <= 50;

    if (fillLocked || noExpectancy) {
      const reasons: string[] = [];
      if (fillLocked) reasons.push(`approved fills ${approvedFills}/${this.minApprovedFills}`);
      if (noExpectancy) reasons.push(`expectancy not proven (${closed === 0 ? 'no closed entries' : `winRate ${winRatePct}%`})`);
      return {
        allowed: false,
        approvedFills,
        winRatePct,
        reason: `AUTO locked — ${reasons.join('; ')}`,
      };
    }

    return {
      allowed: true,
      approvedFills,
      winRatePct,
      reason: `AUTO unlocked (${approvedFills} approved fills, ${winRatePct}% win rate)`,
    };
  }
}

export const globalApprovalQueueService = new ApprovalQueueService();
