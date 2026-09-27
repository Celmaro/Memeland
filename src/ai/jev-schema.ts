/**
 * P5.2 — Jev schema + router (verified: TypeSafe System One model, real API).
 *
 * Jev = fast bounded decisions from a compact FeatureSnapshot. It is NOT the
 * strategy — it routes enrichment and classifies regime with calibrated
 * probabilities. The router is fail-closed: disabled (JEV_ENABLED != true),
 * errored, or invalid output → swarm fallback, never fabricated odds.
 *
 * Non-negotiable: Jev never executes trades and never overrides the
 * deterministic security/risk gates.
 */

export const JEV_REGIMES = ['MOMENTUM', 'REVIVAL', 'CTO', 'ACCUMULATION', 'NO_TRADE'] as const;
export const JEV_ACTIONS = [
  'NO_TRADE',
  'REQUEST_GMGN',
  'REQUEST_CMC_HOLDERS',
  'REQUEST_GECKO_OHLCV',
  'REQUEST_RPC_FORENSICS',
  'ESCALATE_LLM',
  'RUN_FINAL_SIMULATION',
  'READY_FOR_STRATEGY',
  'ENRICH_GMGN',
] as const;

export interface JevOutput {
  regime: (typeof JEV_REGIMES)[number];
  continuationProb: number; // 0..1
  flowQuality: number;      // 0..1
  walletIndependence: number; // 0..1
  exhaustion: number;       // 0..1
  executionQuality: number; // 0..1
  nextAction: (typeof JEV_ACTIONS)[number];
}

export function validateJevOutput(o: unknown): { ok: boolean; reason?: string } {
  if (typeof o !== 'object' || o === null) return { ok: false, reason: 'not an object' };
  const v = o as Record<string, unknown>;
  if (typeof v.regime !== 'string' || !(JEV_REGIMES as readonly string[]).includes(v.regime)) return { ok: false, reason: 'unknown regime' };
  if (typeof v.nextAction !== 'string' || !(JEV_ACTIONS as readonly string[]).includes(v.nextAction)) return { ok: false, reason: 'unknown action' };
  for (const k of ['continuationProb', 'flowQuality', 'walletIndependence', 'exhaustion', 'executionQuality'] as const) {
    const n = Number(v[k]);
    if (!Number.isFinite(n) || n < 0 || n > 1) return { ok: false, reason: `${k} out of range` };
  }
  return { ok: true };
}
