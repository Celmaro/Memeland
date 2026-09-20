/**
 * SRC-108 copy-trade sizing + paper-broker dry-run engine.
 * Proportional per-leader sizing with fail-closed validation, plus a
 * deterministic, zero-dependency paper broker that NEVER touches a live
 * executor. Pure math, no I/O, no SDKs — everything is a pure function or
 * an in-memory broker.
 */

export interface CopySizeConfig {
  baseNotionalUsd: number;
  maxNotionalUsd: number;
  minNotionalUsd: number;
}

/**
 * Proportional notional sizing = base * leaderMultiplier, floored to
 * minNotionalUsd and capped at maxNotionalUsd.
 *
 * Fail-closed rules:
 *  - non-finite/negative base or multiplier => 0
 *  - non-finite/negative config bounds => 0
 *  - min > max (misconfigured) => 0
 *  - otherwise clamp result to [min, max] (0 returned ONLY on invalid input)
 */
export function sizeCopyPosition(
  baseNotionalUsd: number,
  leaderMultiplier: number,
  cfg: CopySizeConfig
): number {
  if (!Number.isFinite(baseNotionalUsd) || !Number.isFinite(leaderMultiplier)) return 0;
  if (baseNotionalUsd < 0 || leaderMultiplier < 0) return 0;
  if (
    !Number.isFinite(cfg.baseNotionalUsd) ||
    !Number.isFinite(cfg.maxNotionalUsd) ||
    !Number.isFinite(cfg.minNotionalUsd)
  ) {
    return 0;
  }
  if (cfg.baseNotionalUsd < 0 || cfg.maxNotionalUsd < 0 || cfg.minNotionalUsd < 0) return 0;
  if (cfg.minNotionalUsd > cfg.maxNotionalUsd) return 0;

  const raw = baseNotionalUsd * leaderMultiplier;
  return Math.max(cfg.minNotionalUsd, Math.min(cfg.maxNotionalUsd, raw));
}

export interface PaperFill {
  id: string;
  tokenAddress: string;
  side: 'buy' | 'sell';
  sizeUsd: number;
  midPriceUsd: number;
  slippagePct: number;
  fillPriceUsd: number;
  slipUsd: number;
  sequence: number;
  /** Set true by closePosition once realized; guards against double-counting. */
  closed?: boolean;
}

export type PaperTransport = {
  submit: (f: PaperFill) => Promise<{ accepted: boolean }>;
};

export interface SubmitFillOptions {
  tokenAddress: string;
  side: 'buy' | 'sell';
  sizeUsd: number;
  midPriceUsd: number;
  slippagePct: number;
}

export interface SubmitFillResult {
  accepted: boolean;
  fill?: PaperFill;
  reason?: string;
}

const ZERO_DEPTH_REASON = 'zero/illiquid depth — fail-closed';

/** Signed tracking notional of a fill: buys debit (-), sells credit (+). */
function signedNotional(fill: PaperFill): number {
  return fill.side === 'buy' ? -fill.sizeUsd : fill.sizeUsd;
}

export class PaperBroker {
  private _fills: PaperFill[] = [];
  private _seq = 0;
  private _transport: PaperTransport | null;

  constructor(transport: PaperTransport | null = null) {
    this._transport = transport;
  }

  get fills(): readonly PaperFill[] {
    // Shallow copies so callers can't mutate internal state; sorted in
    // monotonically increasing sequence order.
    return this._fills
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((f) => ({ ...f }));
  }

  get sequence(): number {
    return this._seq;
  }

  async submitFill(opts: SubmitFillOptions): Promise<SubmitFillResult> {
    // Fail-closed: zero/negative/non-finite size or zero/negative mid price
    // is rejected — zero/illiquid depth is never best-effort.
    if (
      !Number.isFinite(opts.sizeUsd) ||
      opts.sizeUsd <= 0 ||
      !Number.isFinite(opts.midPriceUsd) ||
      opts.midPriceUsd <= 0
    ) {
      return { accepted: false, reason: ZERO_DEPTH_REASON };
    }
    if (!Number.isFinite(opts.slippagePct)) {
      return { accepted: false, reason: ZERO_DEPTH_REASON };
    }

    const seq = this._seq + 1;
    const fillPriceUsd =
      opts.midPriceUsd * (1 + (opts.slippagePct / 100) * (opts.side === 'buy' ? 1 : -1));
    const slipUsd =
      opts.midPriceUsd > 0
        ? (Math.abs(fillPriceUsd - opts.midPriceUsd) * opts.sizeUsd) / opts.midPriceUsd
        : 0;

    // A non-finite / zero / negative result fill is also fail-closed rejected
    // (e.g. a sell with slippage beyond 100% pushes the fill price <= 0).
    if (!Number.isFinite(fillPriceUsd) || fillPriceUsd <= 0) {
      return { accepted: false, reason: ZERO_DEPTH_REASON };
    }

    const fill: PaperFill = {
      id: `${seq}:${opts.tokenAddress}:${opts.side}`,
      tokenAddress: opts.tokenAddress,
      side: opts.side,
      sizeUsd: opts.sizeUsd,
      midPriceUsd: opts.midPriceUsd,
      slippagePct: opts.slippagePct,
      fillPriceUsd,
      slipUsd,
      sequence: seq,
    };

    // The paper broker ALWAYS records — it simulates. An injected transport
    // may decline, but the dry-run record still stands (this never sends a
    // live order; the transport result only reports, it never gates recording).
    this._fills.push(fill);
    this._seq = seq;

    if (this._transport) {
      try {
        await this._transport.submit(fill);
      } catch {
        // Transport failure still leaves the paper fill recorded (simulate).
      }
    }

    return { accepted: true, fill };
  }

  /**
   * Realize an open fill's PnL. Returns signed realized PnL USD (buys debit
   * negative, sells credit positive). Marks the fill closed so reconcilePnl
   * cannot count it more than once. Idempotent: closing an already-closed fill
   * returns realizedPnlUsd 0 and leaves the recorded fill's reconciliation
   * contribution unchanged.
   *
   * Rejects (ok:false) when the fillId does not match any fill for the token.
   */
  closePosition(
    tokenAddress: string,
    fillId: string
  ): { ok: boolean; realizedPnlUsd: number; reason?: string } {
    const fill = this._fills.find((f) => f.id === fillId);
    if (!fill || fill.tokenAddress !== tokenAddress) {
      return { ok: false, realizedPnlUsd: 0, reason: 'no matching open fill' };
    }

    if (fill.closed) {
      // Already realized — do not double count. Return 0 and leave as-is.
      return { ok: true, realizedPnlUsd: 0 };
    }

    const realizedPnlUsd = signedNotional(fill);
    fill.closed = true;
    return { ok: true, realizedPnlUsd };
  }
}

/**
 * Reconcile realized PnL from CLOSED fills. Each fill is counted exactly once
 * (a fill appears at most once in the list by its unique id), so a fill closed
 * twice is still summed a single time — idempotent reconciliation.
 * Closed buys accumulate into buysUsd, closed sells into sellsUsd, and
 * netUsd = sellsUsd - buysUsd (positive = net credit / profitable side).
 */
export function reconcilePnl(fills: readonly PaperFill[]): {
  buysUsd: number;
  sellsUsd: number;
  netUsd: number;
} {
  let buysUsd = 0;
  let sellsUsd = 0;
  const seen = new Set<string>();
  for (const f of fills) {
    if (f.closed !== true) continue;
    if (seen.has(f.id)) continue; // count each unique id once
    seen.add(f.id);
    if (f.side === 'buy') buysUsd += f.sizeUsd;
    else sellsUsd += f.sizeUsd;
  }
  return { buysUsd, sellsUsd, netUsd: sellsUsd - buysUsd };
}