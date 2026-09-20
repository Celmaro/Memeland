/**
 * PR 11 / Standalone #5 — QLO time-on-curve organic-demand filter (SRC-106).
 *
 * qlo measured 97,146 pump.fun graduations: tokens that took hours to fill
 * their bonding curve behaved like organic demand rather than bot sniping.
 * This module ports the chain-portable pieces as a Solana-only quant voter
 * feature:
 *   - slow-fill thresholds: ~1.5x double-rate lift at 2h, ~2.4x five-x-rate
 *     lift at 5h,
 *   - early-stop signature pagination (stop as soon as history proves age),
 *   - raw-pool-state pricing verification (add virtual quote reserves).
 *
 * Additive-only: no existing signature is touched (G1). The whole filter is
 * gated to SOL by the `MULTICHAIN_CHAINS` env var so non-Solana legs never
 * inherit pump.fun fit.
 */

const HOUR_MS = 60 * 60 * 1000;

export const SLOW_CURVE_MIN_HOURS = 2;
export const SLOW_CURVE_FIVE_X_HOURS = 5;
export const SLOW_CURVE_DOUBLE_LIFT = 1.5;
export const SLOW_CURVE_FIVE_X_LIFT = 2.4;

export interface OrganicLift {
  organic: boolean;
  doubleRateLift: number;
  fiveXRateLift: number;
}

export interface TimeOnCurveFilterOptions {
  /** Chains the filter is enabled for; defaults to `MULTICHAIN_CHAINS`. */
  chains?: readonly string[];
}

export interface TimePage {
  signatures: readonly { blockTimeMs?: number }[];
  nextCursor?: string | null;
  truncated?: boolean;
}

export interface TimeOnCurveAssessOptions {
  token: string;
  chain: string;
  graduatedAtMs: number;
  loader: (cursor: string | null) => Promise<TimePage>;
  minAgeHours?: number;
}

export interface TimeOnCurveResult {
  token: string;
  chain: string;
  enabled: boolean;
  timeOnCurveMs: number | null;
  timeOnCurveHours: number | null;
  pagesRead: number;
  earlyStopped: boolean;
  organic: boolean;
  doubleRateLift: number;
  fiveXRateLift: number;
  evidence: string[];
}

/** qlo empirical summary: slow fills raise both the double and five-x hit rates. */
export function classifyOrganicLift(
  timeOnCurveHours: number,
  minOrganicHours = SLOW_CURVE_MIN_HOURS,
): OrganicLift {
  if (!Number.isFinite(timeOnCurveHours) || timeOnCurveHours < minOrganicHours) {
    return { organic: false, doubleRateLift: 1, fiveXRateLift: 1 };
  }
  return {
    organic: true,
    doubleRateLift: SLOW_CURVE_DOUBLE_LIFT,
    fiveXRateLift: timeOnCurveHours >= SLOW_CURVE_FIVE_X_HOURS ? SLOW_CURVE_FIVE_X_LIFT : 1,
  };
}

export interface RawPoolState {
  quoteVaultBalance: number;
  virtualQuoteReserves: number;
  baseReserves: number;
}

/**
 * qlo's PumpSwap pricing bug: virtual_quote_reserves is non-zero on most pools
 * despite the docs. Correct price = quote_vault_balance + virtual_quote_reserves
 * over base. Unreadable state returns null (fail-closed).
 */
export function rawPoolPrice(pool: RawPoolState): number | null {
  const { quoteVaultBalance, virtualQuoteReserves, baseReserves } = pool;
  if (
    !Number.isFinite(quoteVaultBalance) ||
    !Number.isFinite(virtualQuoteReserves) ||
    !Number.isFinite(baseReserves) ||
    baseReserves <= 0
  ) {
    return null;
  }
  const price = (quoteVaultBalance + virtualQuoteReserves) / baseReserves;
  return Number.isFinite(price) && price > 0 ? price : null;
}

export interface RawPoolVerifyResult {
  verified: boolean;
  rawPrice: number | null;
  reason: string;
}

export function verifyRawPoolPrice(
  pool: RawPoolState,
  reportedPriceUsd: number,
  tolerancePct = 0.02,
): RawPoolVerifyResult {
  const rawPrice = rawPoolPrice(pool);
  if (rawPrice === null) {
    return { verified: false, rawPrice, reason: 'raw pool state unreadable' };
  }
  if (!Number.isFinite(reportedPriceUsd) || reportedPriceUsd <= 0) {
    return { verified: false, rawPrice, reason: 'reported price unreadable' };
  }
  const drift = Math.abs(reportedPriceUsd - rawPrice) / rawPrice;
  if (drift > tolerancePct) {
    return { verified: false, rawPrice, reason: `mispricing drift ${drift.toFixed(6)}` };
  }
  return { verified: true, rawPrice, reason: 'raw pool price validated' };
}

export class TimeOnCurveFilter {
  private readonly enabledChains: string[];

  constructor(opts: TimeOnCurveFilterOptions = {}) {
    this.enabledChains = opts.chains
      ? opts.chains.map((c) => c.toLowerCase())
      : envChains();
  }

  public isEnabled(chain: string): boolean {
    return chain.toLowerCase() === 'sol' && this.enabledChains.includes('sol');
  }

  public async assess(opts: TimeOnCurveAssessOptions): Promise<TimeOnCurveResult> {
    if (!this.isEnabled(opts.chain)) {
      return {
        token: opts.token,
        chain: opts.chain,
        enabled: false,
        timeOnCurveMs: null,
        timeOnCurveHours: null,
        pagesRead: 0,
        earlyStopped: false,
        organic: false,
        doubleRateLift: 1,
        fiveXRateLift: 1,
        evidence: [`MULTICHAIN_CHAINS gate disabled ${opts.chain}`],
      };
    }

    const minAgeHours = opts.minAgeHours ?? SLOW_CURVE_MIN_HOURS;
    const minAgeMs = minAgeHours * HOUR_MS;
    let earliestSeenMs: number | null = null;
    let cursor: string | null = null;
    let pagesRead = 0;
    let earlyStopped = false;
    let outOfPages = false;

    while (!earlyStopped && !outOfPages) {
      const page = await opts.loader(cursor);
      pagesRead += 1;
      for (const sig of page.signatures) {
        const t = sig.blockTimeMs;
        if (typeof t !== 'number' || !Number.isFinite(t)) continue;
        earliestSeenMs = earliestSeenMs === null ? t : Math.min(earliestSeenMs, t);
        if (opts.graduatedAtMs - earliestSeenMs >= minAgeMs) {
          earlyStopped = true;
          break;
        }
      }
      if (page.nextCursor === null || page.nextCursor === undefined) {
        outOfPages = true;
      } else {
        cursor = page.nextCursor;
      }
    }

    const timeOnCurveMs =
      earliestSeenMs === null ? null : Math.max(0, opts.graduatedAtMs - earliestSeenMs);
    const timeOnCurveHours = timeOnCurveMs === null ? null : timeOnCurveMs / HOUR_MS;
    const lift =
      timeOnCurveHours === null
        ? { organic: false, doubleRateLift: 1, fiveXRateLift: 1 }
        : classifyOrganicLift(timeOnCurveHours, minAgeHours);
    const evidence: string[] = [];

    if (earlyStopped) {
      evidence.push(`early-stop after ${pagesRead} page(s)`);
    }
    if (timeOnCurveMs === null) {
      evidence.push('history unreadable: no first transaction timestamp');
    }
    if (lift.organic) {
      evidence.push(`organic slow fill ${timeOnCurveHours?.toFixed(2) ?? '?'}h >= ${minAgeHours}h`);
    }

    return {
      token: opts.token,
      chain: opts.chain,
      enabled: true,
      timeOnCurveMs,
      timeOnCurveHours,
      pagesRead,
      earlyStopped,
      organic: lift.organic,
      doubleRateLift: lift.doubleRateLift,
      fiveXRateLift: lift.fiveXRateLift,
      evidence,
    };
  }
}

function envChains(): string[] {
  return (process.env.MULTICHAIN_CHAINS ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
}
