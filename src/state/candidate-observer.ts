/**
 * T1 — Non-gating candidate-state observer (wires the causal reducer + the
 * zero-alloc ML fast-scorer into the live discovery surface).
 *
 * These helpers RECORD causal state transitions for candidates as discovery /
 * enrichment events arrive. They NEVER gate, drop, or alter any decision — a
 * record is written best-effort and any failure is swallowed (fail-open). The
 * observer is the production consumer that connects the Helius/discovery ingress
 * to the `CandidateStateStore` reducer and uses the ML `fast-scorer` as the
 * `score` value for the `ML_SCORE_EVALUATED` transition.
 */
import { CandidateStateStore, globalCandidateStateStore, type CandidateStateRecord } from './candidate-state.js';
import { scoreCandidate, type FastScorerInput } from '../ml/fast-scorer.js';

export interface DiscoveryObservation {
  /** chain:address / mint */
  id: string;
  baseReserveUsd?: number;
  volume1hUsd?: number;
  liquidityGateUsd?: number;
}

/**
 * Record a discovery event into the causal reducer: allocate + transition to
 * DISCOVERED, then (when liquidity meets the gate) to SCREENED_L1. Non-gating —
 * returns the current record or null; never throws.
 */
export async function recordDiscovery(
  store: CandidateStateStore,
  obs: DiscoveryObservation,
  now: () => number = Date.now,
): Promise<CandidateStateRecord | null> {
  try {
    const discovered = await store.transition(obs.id, 'DISCOVERY_EVENT', {
      mutation: () => ({ baseReserveUsd: obs.baseReserveUsd ?? 0, volume1hUsd: obs.volume1hUsd ?? 0 }),
    });
    const record = discovered.record ?? (await store.get(obs.id));
    if (record) {
      await store.transition(obs.id, 'RESERVE_INJECTED', {
        context: { liquidityGateUsd: obs.liquidityGateUsd ?? 1000 },
      });
    }
    return record;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CANDIDATE OBSERVER] recordDiscovery ${obs.id} failed (non-gating): ${msg}`);
    return null;
  }
}

export interface ScoreObservation extends DiscoveryObservation {
  snapshot: FastScorerInput;
  scoreThreshold?: number;
}

/**
 * Score an observed candidate with the zero-alloc fast scorer and record the
 * `ML_SCORE_EVALUATED` transition with that score. Non-gating — only records;
 * never blocks or drops. Returns the resulting record or null.
 */
export async function recordScore(
  store: CandidateStateStore,
  obs: ScoreObservation,
  now: () => number = Date.now,
): Promise<CandidateStateRecord | null> {
  try {
    const verdict = scoreCandidate(obs.snapshot, { threshold: obs.scoreThreshold });
    const result = await store.transition(obs.id, 'ML_SCORE_EVALUATED', {
      mutation: () => ({ score: verdict.score, volume1hUsd: obs.snapshot.buyVol1hUsd }),
      context: { scoreThreshold: obs.scoreThreshold ?? 0 },
    });
    return result.record ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CANDIDATE OBSERVER] recordScore ${obs.id} failed (non-gating): ${msg}`);
    return null;
  }
}

/** Process-wide observer backed by the global candidate store. */
export const globalCandidateObserver = {
  recordDiscovery: (obs: DiscoveryObservation) => recordDiscovery(globalCandidateStateStore, obs),
  recordScore: (obs: ScoreObservation) => recordScore(globalCandidateStateStore, obs),
};