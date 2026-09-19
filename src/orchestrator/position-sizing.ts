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
