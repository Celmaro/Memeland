/**
 * PR 3 / Kernel B — consensus guard helpers (ADOPTIVE, keeps the golden-master
 * `aggregateVoterScores` untouched so the 570-test floor cannot regress; G3).
 *
 * Adds, without replacing the existing weighted average:
 *   - asymmetric conflict     (SRC-097 Decision Hub A5: 1BUY+2SELL = veto)
 *   - downgrade-only confidence (SRC-233 zetryn A27 CalibrationMap)
 *   - cohort Jaccard voter    (SRC-194 FlySwarm A21)
 *   - circuit breaker         (SRC-204 pump-scanner Adapt)
 *   - sticky conviction       (SRC-184 azimuth A16)
 *   - RefusalCode vocabulary  (SRC-197 loxley A14 + Decision Hub A5)
 */

export type RefusalCode =
  | 'LOW_CONFIDENCE'
  | 'ASYMMETRIC_CONFLICT'
  | 'CIRCUIT_OPEN'
  | 'PARSER_UNTRUSTWORTHY'
  | 'SELL_NOT_OPENABLE';

/**
 * Single consensus floor (80%). The regime voter was removed (no edge — a 4%
 * vote could never stop a fire and dragged the average toward neutral); the
 * floor is a flat constant, not regime-aware.
 */
export const CONSENSUS_FLOOR = 0.8;

export interface DirectionVote {
  side: 'BUY' | 'SELL';
  weight: number;
}

/**
 * Decision Hub asymmetric conflict: any BUY+SELL mix is a conflict; when SELL
 * weight is >= 2x BUY weight the direction is vetoed (1BUY + 2SELL = 0.0).
 */
export function resolveConflict(votes: DirectionVote[]): { conflicted: boolean; resume: boolean; reason?: string } {
  const buy = votes.filter((v) => v.side === 'BUY').reduce((a, b) => a + b.weight, 0);
  const sell = votes.filter((v) => v.side === 'SELL').reduce((a, b) => a + b.weight, 0);
  if (buy > 0 && sell > 0) {
    if (sell >= 2 * buy) {
      return { conflicted: true, resume: false, reason: 'asymmetric conflict — SELL outweighs BUY >= 2:1 (veto)' };
    }
    return { conflicted: true, resume: true, reason: 'conflict present but below the asymmetric veto threshold' };
  }
  return { conflicted: false, resume: true };
}

/** zetryn downgrade-only: calibrated confidence never exceeds the raw score. */
export function calibratedConfidence(score: number, calibration: Record<number, number> | null): number {
  if (!calibration) return score;
  const mapped = calibration[Math.round(score)];
  if (typeof mapped !== 'number' || Number.isNaN(mapped)) return score;
  return Math.min(score, mapped);
}

/** Jaccard overlap between two address/feature sets (FlySwarm cohort signal). */
export function jaccardOverlap(a: Iterable<string>, b: Iterable<string>): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

/** FlySwarm cohort voter: scores 0-100 by how much the observed set overlaps the cohort. */
export function cohortVote(observed: string[], cohort: string[]): { crimeNoise: number; score: number } {
  const overlap = jaccardOverlap(observed, cohort);
  return { crimeNoise: overlap, score: Math.round(overlap * 100) };
}

/** pump-scanner circuit breaker: N consecutive failures open the circuit for a cooldown. */
export class CircuitBreaker {
  private fails = 0;
  private trippedAt = 0;

  constructor(
    private readonly failThreshold: number = 3,
    private readonly cooldownMs: number = 3_600_000,
    private readonly now: () => number = Date.now
  ) {}

  /** `failed` = the check failed (trips toward open); `false` = success resets. */
  public record(failed: boolean): { tripped: boolean; cooldownMs: number } {
    const now = this.now();
    if (failed) {
      this.fails += 1;
      if (this.fails >= this.failThreshold) {
        this.trippedAt = now;
        this.fails = 0;
        return { tripped: true, cooldownMs: this.cooldownMs };
      }
    } else {
      this.fails = 0;
    }
    const remaining = this.trippedAt > 0 ? Math.max(0, this.trippedAt + this.cooldownMs - now) : 0;
    return { tripped: remaining > 0, cooldownMs: remaining };
  }

  public reset(): void {
    this.fails = 0;
    this.trippedAt = 0;
  }

  /** True when the circuit is still in a cooldown from a previous trip. */
  public isOpen(): boolean {
    if (this.trippedAt <= 0) return false;
    return this.now() - this.trippedAt < this.cooldownMs;
  }
}

/** azimuth sticky conviction: short-TTL cache; a stale entry is treated as absent. */
export class StickyConviction {
  private readonly entries = new Map<string, { value: number; at: number }>();

  constructor(
    private readonly ttlMs: number = 300_000,
    private readonly now: () => number = Date.now
  ) {}

  public get(key: string): number | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (this.now() - e.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return e.value;
  }

  public store(key: string, value: number): void {
    this.entries.set(key, { value, at: this.now() });
  }
}
