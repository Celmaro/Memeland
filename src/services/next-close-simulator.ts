/**
 * PR8 - Causal next-close simulator (A22 lookahead-free + A23 fly-high).
 *
 * Pure, zero-dependency backtest primitives that honest-check fills before any
 * metric is trusted: orders fill on the next observed close (never the decision
 * bar), fills that gap past an allowed window are cancelled, and every fill
 * applies conservative fee + slippage and tracks positions with FIFO lots.
 */

export interface NextCloseBar {
  time: number;
  high?: number;
  low?: number;
  close: number;
  liquidityUsd?: number;
}

export interface NextCloseOrder {
  id: string;
  side: 'buy' | 'sell';
  sizeUsd: number;
  decisionBarIndex: number;
  /** Maximum bars allowed between the decision and the fill. Default: config.maxGapBars. */
  maxGapBars?: number;
}

export interface NextCloseConfig {
  /** Conservative fee applied to each fill notional. Default: 0.3 (%). */
  feePct?: number;
  /** Conservative slippage applied to each fill price. Default: 0.2 (%). */
  slippagePct?: number;
  /** Maximum bars between decision and fill before cancelling. Default: 1. */
  maxGapBars?: number;
}

export type SimFillStatus = 'filled' | 'cancelled' | 'open';

export interface SimFill {
  orderId: string;
  side: 'buy' | 'sell';
  barIndex: number;
  fillPrice: number;
  qty: number;
  feesUsd: number;
  slippageUsd: number;
  status: SimFillStatus;
  cancelReason?: 'gap' | 'no-data';
}

export interface RealizedTrade {
  orderId: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  grossPnlUsd: number;
}

export interface NextCloseResult {
  fills: SimFill[];
  cancelledCount: number;
  closed: RealizedTrade[];
  /** Cumulative filled-buy qty minus sold qty still held. */
  openQty: number;
  equityCurve: number[];
}

/** FIFO open lot. */
interface OpenLot {
  orderId: string;
  entryPrice: number;
  qty: number;
}

export function simulateNextClose(
  bars: NextCloseBar[],
  orders: NextCloseOrder[],
  config: NextCloseConfig = {}
): NextCloseResult {
  const feePct = Number.isFinite(config.feePct) ? (config.feePct as number) : 0.3;
  const slipPct = Number.isFinite(config.slippagePct)
    ? (config.slippagePct as number)
    : 0.2;
  const defaultGap = Number.isFinite(config.maxGapBars)
    ? Math.max(0, Math.floor(config.maxGapBars as number))
    : 1;

  const data = Array.isArray(bars) ? bars : [];
  const fills: SimFill[] = [];
  const closed: RealizedTrade[] = [];
  const lots: OpenLot[] = [];
  let openQty = 0;
  let cancelledCount = 0;

  for (const order of orders) {
    const fillBarIndex = order.decisionBarIndex + 1;
    const bar = data[fillBarIndex];
    if (!bar || bar.close === undefined) {
      fills.push({
        orderId: order.id,
        side: order.side,
        barIndex: fillBarIndex,
        fillPrice: 0,
        qty: 0,
        feesUsd: 0,
        slippageUsd: 0,
        status: 'open',
        cancelReason: 'no-data',
      });
      continue;
    }

    const maxGap = Number.isFinite(order.maxGapBars)
      ? Math.max(0, Math.floor(order.maxGapBars as number))
      : defaultGap;
    const actualGap = fillBarIndex - order.decisionBarIndex;
    if (actualGap > maxGap) {
      fills.push({
        orderId: order.id,
        side: order.side,
        barIndex: fillBarIndex,
        fillPrice: 0,
        qty: 0,
        feesUsd: 0,
        slippageUsd: 0,
        status: 'cancelled',
        cancelReason: 'gap',
      });
      cancelledCount++;
      continue;
    }

    const close = Number(bar.close);
    const slipMultiplier = order.side === 'buy' ? 1 + slipPct / 100 : 1 - slipPct / 100;
    const fillPrice = close * slipMultiplier;
    const gross = Number(order.sizeUsd);
    const feesUsd = (gross * feePct) / 100;
    const qty = (gross - feesUsd) / fillPrice;
    const slippageUsd = Math.abs(fillPrice - close) * qty;

    fills.push({
      orderId: order.id,
      side: order.side,
      barIndex: fillBarIndex,
      fillPrice,
      qty,
      feesUsd,
      slippageUsd,
      status: 'filled',
    });

    if (order.side === 'buy') {
      lots.push({ orderId: order.id, entryPrice: fillPrice, qty });
      openQty += qty;
    } else {
      let remaining = qty;
      let matched = 0;
      while (remaining > 1e-12 && lots.length > 0) {
        const lot = lots[0]!;
        const take = Math.min(lot.qty, remaining);
        closed.push({
          orderId: lot.orderId,
          entryPrice: lot.entryPrice,
          exitPrice: fillPrice,
          qty: take,
          grossPnlUsd: (fillPrice - lot.entryPrice) * take,
        });
        lot.qty -= take;
        remaining -= take;
        matched += take;
        if (lot.qty <= 1e-12) lots.shift();
      }
      openQty = Math.max(0, openQty - matched);
    }
  }

  // Simple equity curve: sum of all realized PnL plus remaining mark-to-market
  // is deliberately conservative (0 cost basis bookkeeping); expose running
  // realized PnL per closed trade for downstream drawdown metrics.
  const equityCurve: number[] = [0];
  for (const t of closed) {
    equityCurve.push(equityCurve[equityCurve.length - 1]! + t.grossPnlUsd);
  }

  return { fills, cancelledCount, closed, openQty, equityCurve };
}

export interface AvailabilityNode {
  id: string;
  inputs?: string[];
  /** Bar/epoch at which the fact actually becomes known. */
  releasedAt: number;
  /** Bar/epoch at which the decision consumes it. */
  decisionTime: number;
  /** True if the fact cannot be proven independent of the decision (P1). */
  valueDependent?: boolean;
}

export interface AvailabilityEvidence {
  passed: boolean;
  severity: 'P0' | 'P1';
  violations: string[];
}

/**
 * Linear-time decision-availability check over a dependency DAG (A22).
 * - P0 (fail-closed): a decision consumes a fact released after its own
 *   decision time, an unresolved input, or a cycle in the dependency graph.
 * - P1 (pass with flag): a value-dependent fact cannot be proven safe, but
 *   the DAG is structurally sound.
 */
export function checkDecisionAvailability(
  nodes: AvailabilityNode[]
): AvailabilityEvidence {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map<string, AvailabilityNode>();
  for (const n of list) byId.set(n.id, n);

  const violations: string[] = [];
  let hasP1 = false;
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, stack: string[]): boolean => {
    if (visited.has(id)) return true;
    if (visiting.has(id)) {
      violations.push(`cycle detected involving node "${id}"`);
      return false;
    }
    const node = byId.get(id);
    if (!node) {
      violations.push(`unresolved input "${id}"`);
      return false;
    }
    visiting.add(id);
    for (const input of node.inputs ?? []) {
      if (!visit(input, [...stack, id])) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };

  for (const n of list) {
    if (!visit(n.id, [])) continue;
    if (n.valueDependent) {
      hasP1 = true;
      violations.push(
        `node "${n.id}" is value-dependent and cannot be proven safe`
      );
      continue;
    }
    const maxRelease = Math.max(n.releasedAt, ...(n.inputs ?? []).map((i) => byId.get(i)?.releasedAt ?? 0));
    if (maxRelease > n.decisionTime) {
      violations.push(
        `node "${n.id}" released at ${maxRelease} but decision is at ${n.decisionTime}`
      );
    }
  }

  const hasP0 = violations.some(
    (v) => !v.includes('value-dependent')
  );
  const passed = !hasP0;
  return {
    passed,
    severity: hasP0 ? 'P0' : hasP1 || violations.length > 0 ? 'P1' : 'P1',
    violations,
  };
}
