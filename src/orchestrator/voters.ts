/**
 * 7-voter swarm (Arch 3): each voter renders an independent 0-100 opinion with
 * reasons; the swarm gate (swarm-consensus.ts) aggregates them as a weighted
 * average. Voters are deterministic math or LLM-on-finalists only — verdicts
 * are never left to a single agent.
 *
 * Wires in (2026-09-18):
 *   1 quant     — meme agent pipeline confidence (rank/trenches/hot + detectMemeSignal)
 *   2 ml        — ml-predictor.ts: kline momentum → P(up) as a 0-100 vote
 *   3 security  — GoPlus + GMGN audit + holder concentration (fail-closed 0 on audit fail)
 *   4 sentiment — sentiment-voter.ts: X / on-chain social fields (X optional)
 *   5 whale     — GMGN smart-money/KOL trade flow (accumulation vs exit)
 *   6 regime    — market-regime + DeFiLlama chain TVL/DEX-volume context
 *   7 critic    — critic-voter.ts: LLM adversarial pass, neutral (50) when unavailable
 */

import type { GMGNRawToken } from '../adapters/gmgn-adapter.js';

export type VoterId = 'quant' | 'ml' | 'security' | 'sentiment' | 'whale' | 'regime' | 'critic';

export const VOTER_IDS: VoterId[] = ['quant', 'ml', 'security', 'sentiment', 'whale', 'regime', 'critic'];

/**
 * Default relative weights (sum ≈ 1.0). Security carries the most weight —
 * consistent with the fail-closed ethos. Regime is deliberately small:
 * chain-wide context must never override a strong token-level signal.
 */
export const DEFAULT_VOTER_WEIGHTS: Record<VoterId, number> = {
  quant: 0.2,
  ml: 0.15,
  security: 0.25,
  sentiment: 0.15,
  whale: 0.1,
  regime: 0.05,
  critic: 0.1,
};

export interface VoterOpinion {
  voter: VoterId;
  /** 0-100. Neutral = 50 (no information), never fabricated. */
  score: number;
  /** Relative weight in the consensus average; falls back to DEFAULT_VOTER_WEIGHTS. */
  weight?: number;
  reasons: string[];
}

export interface VoterContext {
  token: GMGNRawToken;
  chain: string;
  nativePriceUsd: number | null;
  securityAuditPassed: boolean;
  /** Meme-agent pipeline confidence (0-100) BEFORE strategy blending — the quant vote. */
  signalConfidence: number;
  /** GMGN smart-money/KOL trade feed rows for this token, if fetched. */
  trackTrades?: Array<{ side: 'buy' | 'sell'; amountUsd: number; isFullClose: boolean }>;
  /** Market-regime snapshot, if available. */
  regime?: { volatilityIndex: number; riskOff: boolean } | null;
  /** 15m klines for the ML predictor, if fetched. */
  klines?: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null;
}

export type VoterScores = Partial<Record<VoterId, number>>;

/**
 * Weighted consensus across the provided voter scores. Only voters with a
 * number score participate; missing voters are ignored (never treated as 0).
 * Returns the rounded weighted average clamped to 0-100, plus per-voter detail.
 */
export function aggregateVoterScores(
  scores: VoterScores,
  weights: Partial<Record<VoterId, number>> = {}
): { score: number; breakdown: Record<string, number> } {
  let num = 0;
  let den = 0;
  const breakdown: Record<string, number> = {};
  for (const id of VOTER_IDS) {
    const s = scores[id];
    if (typeof s !== 'number' || !Number.isFinite(s)) continue;
    const w = weights[id] ?? DEFAULT_VOTER_WEIGHTS[id];
    if (!(w > 0)) continue;
    num += Math.max(0, Math.min(100, s)) * w;
    den += w;
    breakdown[id] = Math.round(Math.max(0, Math.min(100, s)));
  }
  if (den <= 0) return { score: 0, breakdown };
  return { score: Math.round(num / den), breakdown };
}

/** Helper: quant score is the meme-agent's own signal confidence. */
export function quantVote(signalConfidence: number, reasons: string[] = []): VoterOpinion {
  return { voter: 'quant', score: Math.max(0, Math.min(100, signalConfidence)), reasons };
}

/** Helper: security vote is fail-closed — 0 on audit failure, 100 on pass (plus holder notes subtract below 100). */
export function securityVote(auditPassed: boolean, penalties: string[] = []): VoterOpinion {
  if (!auditPassed) {
    return { voter: 'security', score: 0, reasons: ['security audit failed — fail-closed'] };
  }
  const score = Math.max(0, 100 - penalties.length * 10);
  return { voter: 'security', score, reasons: penalties.length > 0 ? penalties : ['audit passed'] };
}

/** Helper: whale vote from GMGN smart-money/KOL flow — accumulation lifts, heavy sells/full-closes cap it. */
export function whaleVote(trades: VoterContext['trackTrades'] = []): VoterOpinion {
  if (!trades || trades.length === 0) {
    return { voter: 'whale', score: 50, reasons: ['no smart-money flow data — neutral'] };
  }
  let buys = 0;
  let sells = 0;
  for (const t of trades) {
    if (t.side === 'buy') buys += t.amountUsd;
    else sells += t.amountUsd;
  }
  const total = buys + sells;
  if (total <= 0) return { voter: 'whale', score: 50, reasons: ['zero smart-money volume — neutral'] };
  const netRatio = (buys - sells) / total; // -1..1
  const score = Math.round(50 + netRatio * 40); // -40..+40 around neutral
  const exitFlags = trades.filter((t) => t.side === 'sell' && t.isFullClose).length;
  const finalScore = Math.max(0, Math.min(100, score - exitFlags * 10));
  const reasons = [
    `smart-money buys $${(buys / 1000).toFixed(1)}k / sells $${(sells / 1000).toFixed(1)}k`,
    exitFlags > 0 ? `${exitFlags} full close(s) detected` : 'no full closes',
  ];
  return { voter: 'whale', score: finalScore, reasons };
}

/** Helper: regime vote — risk-off caps the score at 45, high volatility adds small caution. */
export function regimeVote(regime: VoterContext['regime']): VoterOpinion {
  if (!regime) return { voter: 'regime', score: 50, reasons: ['regime unknown — neutral'] };
  let score = 50;
  const reasons: string[] = [];
  if (regime.riskOff) {
    score = Math.min(score, 45);
    reasons.push('macro risk-off (whale flows negative)');
  }
  if (regime.volatilityIndex > 70) {
    score -= 10;
    reasons.push(`extreme volatility index ${regime.volatilityIndex}`);
  } else if (regime.volatilityIndex < 25) {
    score += 10;
    reasons.push(`calm regime (vol index ${regime.volatilityIndex})`);
  }
  return { voter: 'regime', score: Math.max(0, Math.min(100, score)), reasons: reasons.length > 0 ? reasons : ['regime neutral'] };
}

/** Build a full VoterScores map from opinions that actually rendered. */
export function scoresFromOpinions(opinions: VoterOpinion[]): VoterScores {
  const out: VoterScores = {};
  for (const o of opinions) out[o.voter] = o.score;
  return out;
}