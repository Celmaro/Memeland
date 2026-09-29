/**
 * P5 — ResearchCoordinator extraction.
 *
 * The held roadmap: "post-consensus cost/priority logic becomes measurable."
 * Historically the research budget guard (`maxScorePerCycle`) was an ad-hoc cap
 * inline in the Strategist cycle. ResearchCoordinator owns that decision so it
 * can be MEASURED (per-candidate cost, per-source spend, running budget) instead
 * of just capped:
 *
 *   - ADMISSION budget: how many candidates the swarm may score this cycle.
 *   - COST metering: each research/enrichment action carries a cost; the
 *     coordinator meters it against the per-cycle budget and (optionally) a
 *     process-wide currency tracked in the ephemeral store (Redis when armed,
 *     in-memory otherwise) so concurrent passes share the same spend.
 *   - PRIORITY: when more candidates than budget demand scoring, the cheapest /
 *     highest-priority slice wins (admission is explicit, not implicit).
 *
 * Design: pure + deterministic; the only "infrastructure" is the ephemeral
 * store used as a spend meter. No LLM, no network. All costs are integers so
 * budget math never accumulates float error.
 */

import type { EphemeralStore } from '../storage/ephemeral-store.js';
import { globalEphemeralStore } from '../storage/ephemeral-store.js';

/** A discrete research/resource unit measured in abstract credits. */
export type ResearchCostKind = 'swarm_score' | 'enrichment' | 'blockscout' | 'kalp_estimate';

export interface ResearchBudgetConfig {
  /** Max research credits a single cycle may spend on swarm scoring admissions. */
  perCycle: number;
  /** Process-wide currency key; 0 disables cross-pass metering. */
  spendWindowMs: number;
}

/** Fixed cost of each research action (credits). Kept flat & explicit. */
const COST: Record<ResearchCostKind, number> = {
  swarm_score: 1,
  enrichment: 1,
  blockscout: 2,
  kalp_estimate: 3,
};

export interface ResearchAdmission {
  candidateId: string;
  cost: number;
  admitted: boolean;
  reason: string;
}

export interface ResearchSpendView {
  cycleSpent: number;
  cycleBudget: number;
  /** Rolling spend within the configured window (from the ephemeral meter). */
  windowSpent: number;
  remaining: number;
}

/**
 * Receives a fixed admission budget per cycle and an ordered stream of
 * candidates (highest priority first — callers sort). Admits the prefix that
 * fits the remaining budget; the rest are refused with a spend reason so the
 * operator can see WHY a candidate didn't get scored (measurement, not silence).
 */
export class ResearchCoordinator {
  private readonly config: ResearchBudgetConfig;
  private readonly meter: EphemeralStore;
  private cycleSpent = 0;

  constructor(config: Partial<ResearchBudgetConfig> = {}, meter: EphemeralStore = globalEphemeralStore) {
    this.config = {
      perCycle: config.perCycle ?? 5,
      spendWindowMs: config.spendWindowMs ?? 0,
    };
    this.meter = meter;
  }

  /** Cost in credits for a research action. */
  public static cost(kind: ResearchCostKind): number {
    return COST[kind];
  }

  /**
   * Admit candidates in priority order up to the remaining per-cycle budget.
   * A rejected candidate carries the deterministic reason for the refusal.
   */
  public admit(candidates: string[]): { admissions: ResearchAdmission[]; admittedCount: number } {
    const admissions: ResearchAdmission[] = [];
    let admittedCount = 0;
    for (const id of candidates) {
      const cost = COST.swarm_score;
      if (this.cycleSpent + cost > this.config.perCycle) {
        admissions.push({ candidateId: id, cost, admitted: false, reason: `cycle research budget exhausted (${this.cycleSpent}/${this.config.perCycle})` });
        continue;
      }
      this.cycleSpent += cost;
      this.meterResearch(cost);
      admittedCount += 1;
      admissions.push({ candidateId: id, cost, admitted: true, reason: 'admitted' });
    }
    return { admissions, admittedCount };
  }

  /** Meter a non-admission research cost (enrichment / blockscout / kalp). */
  public spend(kind: ResearchCostKind): number {
    const cost = COST[kind];
    this.cycleSpent += cost;
    this.meterResearch(cost);
    return cost;
  }

  /** Current spend view for the [RESEARCH] telemetry line. */
  public view(): ResearchSpendView {
    // Rolling window is honored only when a spend window is configured; otherwise
    // the process-wide meter is reported but not enforced (per-cycle is the gate).
    const windowSpent = this.meter.get<number>('research:window-spent') ?? 0;
    return {
      cycleSpent: this.cycleSpent,
      cycleBudget: this.config.perCycle,
      windowSpent,
      remaining: Math.max(0, this.config.perCycle - this.cycleSpent),
    };
  }

  private meterResearch(cost: number): void {
    if (this.config.spendWindowMs <= 0) return; // cross-pass metering disabled
    const key = 'research:window-spent';
    const next = (this.meter.get<number>(key) ?? 0) + cost;
    this.meter.set(key, next, this.config.spendWindowMs);
  }
}