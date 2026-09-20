/**
 * Q07 - Multi-constraint sizing + layered fail-closed risk gate
 * (SRC-190 COPUMP layered gate, SRC-189 daily-loss halt/cooldown).
 * Pure, zero-dep, chain-agnostic. `sizePosition` collapses to the most
 * restrictive constraint and refuses below the floor; `RuleGate` fails
 * closed on any non-OK rule so UNKNOWN never auto-approves.
 */

export interface SizeConstraints {
  /** Hard notional ceiling for a single entry (RH default $2,000). */
  maxNotionalUsd?: number;
  /** Per-position absolute ceiling. */
  maxUsd?: number;
  /** Refuse any sized amount below this floor. */
  minUsd?: number;
  /** Remaining daily-loss headroom; <=0 halts sizing for the window. */
  dailyLossHeadroomUsd?: number;
}

export interface SizeResult {
  /** The final size, or 0 when refused. */
  sizeUsd: number;
  /** True when sizing is refused (below floor / daily-loss halt / non-positive). */
  refused: boolean;
  /** Name of the constraint that bound the size (for the smallest upper bound). */
  constraint: string;
  reason?: string;
}

const RH_DEFAULT_MAX_NOTIONAL_USD = 2000;

export function sizePosition(desiredUsd: number, c: SizeConstraints = {}): SizeResult {
  if (!Number.isFinite(desiredUsd) || desiredUsd <= 0) {
    return { sizeUsd: 0, refused: true, constraint: 'desired', reason: 'non-positive desired size' };
  }
  if (typeof c.dailyLossHeadroomUsd === 'number' && c.dailyLossHeadroomUsd <= 0) {
    return { sizeUsd: 0, refused: true, constraint: 'dailyLossHeadroom', reason: 'daily-loss halt — sizing suppressed' };
  }

  const bounds: Array<{ name: string; value: number | undefined }> = [
    { name: 'maxNotional', value: c.maxNotionalUsd ?? RH_DEFAULT_MAX_NOTIONAL_USD },
    { name: 'maxUsd', value: c.maxUsd },
    { name: 'dailyLossHeadroom', value: c.dailyLossHeadroomUsd },
  ];
  const active = bounds.filter((b) => typeof b.value === 'number' && Number.isFinite(b.value));
  const binding = active.reduce<{ name: string; value: number } | null>(
    (acc, b) => (acc === null || (b.value as number) < acc.value ? { name: b.name, value: b.value as number } : acc),
    null
  );

  let size = desiredUsd;
  if (binding) {
    size = Math.min(size, binding.value);
  }
  const constraint = binding ? binding.name : 'none';

  if (typeof c.minUsd === 'number' && size < c.minUsd) {
    return { sizeUsd: 0, refused: true, constraint: 'minFloor', reason: `below floor $${c.minUsd}` };
  }
  return { sizeUsd: Math.max(0, Math.round(size)), refused: false, constraint };
}

/**
 * Fractional Kelly: returns the fraction of bankroll to commit, capped to the
 * requested fraction of the full Kelly edge and clamped to [0, 1]. Invalid or
 * negative-edge inputs never invent risk (0).
 */
export function fractionalKelly(winProbability: number, winLossRatio: number, fraction = 0.25): number {
  if (!Number.isFinite(winProbability) || !Number.isFinite(winLossRatio) || !Number.isFinite(fraction)) return 0;
  if (winProbability < 0 || winProbability > 1 || winLossRatio <= 0 || fraction < 0 || fraction > 1) return 0;
  const fullKelly = winProbability - (1 - winProbability) / winLossRatio;
  return Math.max(0, Math.min(1, fullKelly * fraction));
}

/** USD size produced by a fractional-Kelly allocation on a bankroll. */
export function fractionalKellySize(bankrollUsd: number, winProbability: number, winLossRatio: number, fraction = 0.25): number {
  if (!Number.isFinite(bankrollUsd) || bankrollUsd <= 0) return 0;
  return Math.round(bankrollUsd * fractionalKelly(winProbability, winLossRatio, fraction));
}

/** Caps desired size to the remaining daily-loss headroom; 0 means halted. */
export function dailyLossCapSize(desiredUsd: number, maxDailyLossUsd: number, currentDailyLossUsd: number): number {
  if (!Number.isFinite(desiredUsd) || desiredUsd <= 0) return 0;
  if (!Number.isFinite(maxDailyLossUsd) || maxDailyLossUsd <= 0) return 0;
  if (!Number.isFinite(currentDailyLossUsd) || currentDailyLossUsd >= maxDailyLossUsd) return 0;
  const headroom = Math.max(0, maxDailyLossUsd - currentDailyLossUsd);
  return Math.round(Math.min(desiredUsd, headroom));
}

/** Hard notional ceiling for a single position. */
export function maxPositionCapSize(desiredUsd: number, maxPositionUsd: number): number {
  if (!Number.isFinite(desiredUsd) || desiredUsd <= 0) return 0;
  if (!Number.isFinite(maxPositionUsd) || maxPositionUsd <= 0) return 0;
  return Math.round(Math.min(desiredUsd, maxPositionUsd));
}

/** Confidence-scaled sizing: maps 0-100 confidence (or 0-1) linearly. */
export function confidenceScaledSize(baseUsd: number, confidence: number, minScale = 0.5, maxScale = 1.5): number {
  if (!Number.isFinite(baseUsd) || baseUsd <= 0) return 0;
  if (!Number.isFinite(confidence)) return 0;
  const normalized = confidence > 1 ? Math.max(0, Math.min(100, confidence)) / 100 : Math.max(0, Math.min(1, confidence));
  const floor = Math.max(0.1, Math.min(minScale, maxScale));
  const ceil = Math.max(floor, maxScale);
  return Math.round(baseUsd * (floor + (ceil - floor) * normalized));
}

function atrLevel(entryPriceUsd: number, atrUsd: number, multiplier: number, direction: 1 | -1): number {
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return 0;
  if (!Number.isFinite(atrUsd) || atrUsd < 0) return 0;
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 0;
  return entryPriceUsd + direction * atrUsd * multiplier;
}

/** ATR-based stop-loss level below entry. */
export function atrStopLoss(entryPriceUsd: number, atrUsd: number, multiplier = 2): number {
  return atrLevel(entryPriceUsd, atrUsd, multiplier, -1);
}

/** ATR-based take-profit level above entry. */
export function atrTakeProfit(entryPriceUsd: number, atrUsd: number, multiplier = 3): number {
  return atrLevel(entryPriceUsd, atrUsd, multiplier, 1);
}

/**
 * Activation-threshold trailing stop. Returns a trailed stop only after the
 * high-water mark has moved at least `activationPercent` above entry;
 * otherwise it is still inactive.
 */
export function trailingStopPrice(
  entryPriceUsd: number,
  highestPriceUsd: number,
  trailingPercent: number,
  activationPercent = 50
): number | null {
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null;
  if (!Number.isFinite(highestPriceUsd) || highestPriceUsd < entryPriceUsd) return null;
  if (!Number.isFinite(trailingPercent) || trailingPercent <= 0) return null;
  if (!Number.isFinite(activationPercent) || activationPercent < 0) return null;
  if (highestPriceUsd < entryPriceUsd * (1 + activationPercent / 100)) return null;
  return highestPriceUsd * (1 - trailingPercent / 100);
}

export type GateState = 'ok' | 'fail' | 'unknown';

export interface GateResult {
  state: GateState;
  reason?: string;
}

export type GateCheck = () => GateResult | Promise<GateResult>;

export interface GateRule {
  name: string;
  check: GateCheck;
}

/**
 * Fail-closed rule chain. Any rule returning something other than `ok`
 * (including `unknown`) refuses the whole chain — UNKNOWN never auto-approves.
 */
export class RuleGate {
  constructor(private readonly rules: GateRule[] = []) {}

  async evaluate(): Promise<{ allowed: boolean; refusals: string[] }> {
    const refusals: string[] = [];
    for (const rule of this.rules) {
      const r = await rule.check();
      if (r.state !== 'ok') refusals.push(r.reason ? `${rule.name}: ${r.reason}` : `${rule.name}: ${r.state}`);
    }
    return { allowed: refusals.length === 0, refusals };
  }
}

/** A cooldown/rate-halt gate: fails until `now` passes `lastActiveAt + coolMs`. */
export function cooldownGate(lastActiveAt: number | null, coolMs: number, now = Date.now()): GateCheck {
  return () => {
    if (lastActiveAt === null || now >= lastActiveAt + coolMs) return { state: 'ok' };
    const waitMs = lastActiveAt + coolMs - now;
    return { state: 'fail', reason: `cooldown ${Math.ceil(waitMs / 1000)}s remaining` };
  };
}
