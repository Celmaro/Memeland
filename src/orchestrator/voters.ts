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
 *   6 critic    — critic-voter.ts: LLM adversarial pass, neutral (50) when unavailable
 */

import type { GMGNRawToken } from '../adapters/gmgn-adapter.js';
import { walletScore, walletScoreWithReputation, type WalletScoreInput } from '../services/wallet-scoring.js';
import type { ReputationMemory, AegisSnapshot, WalletProfile } from '../services/reputation-memory.js';
import { flowConvergenceScore, type BuyEvent, type FlowConvergenceConfig } from '../services/flow-convergence.js';
import { securityMetricFactors, computeRubric } from '../services/risk-rubric.js';
import type { DecisionCache } from '../services/decision-cache.js';

export type VoterId = 'quant' | 'ml' | 'security' | 'sentiment' | 'whale' | 'critic' | 'wallet' | 'convergence' | 'rubric';

export const VOTER_IDS: VoterId[] = ['quant', 'ml', 'security', 'sentiment', 'whale', 'critic', 'wallet', 'convergence', 'rubric'];

/**
 * Default relative weights (sum ≈ 1.0). Security carries the most weight —
 * consistent with the fail-closed ethos.
 */
export const DEFAULT_VOTER_WEIGHTS: Record<VoterId, number> = {
  quant: 0.1695,
  ml: 0.1271,
  security: 0.2119,
  sentiment: 0.1271,
  whale: 0.0847,
  critic: 0.0847,
  wallet: 0.0677,
  convergence: 0.0509,
  rubric: 0.0763,
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
  /** 15m klines for the ML predictor, if fetched. */
  klines?: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null;
  /** Wallet-scoring metrics (Q03). Missing => neutral, never a false win. */
  walletMetrics?: WalletScoreInput;
  /** Accumulation-convergence buy flow (Q05). Missing/stale/sparse => neutral. */
  convergence?: { buys: BuyEvent[]; config?: FlowConvergenceConfig; now?: number };
  /** Security metric inputs for the risk rubric (Q12). */
  rubricMetrics?: { concentration?: number; spikePct?: number; volatility?: number; liquidityUsd?: number };
  /** Reputation-memory wiring (Kernel A). Missing => existing fail-closed neutral voters. */
  reputation?: VoterReputationContext;
}

export interface VoterReputationContext {
  memory: ReputationMemory;
  deployer: string;
  profile: WalletProfile;
  snapshot: AegisSnapshot;
}

/**
 * Build a Kernel A reputation context from a normalized token. Returns null when
 * no deployer address is present so the live path fails back to the plain
 * fail-closed voters. Snapshot fields default to "no evidence" (not risky)
 * because the deployer-known and below-floor checks are the strong signals.
 */
export function reputationContextFromToken(
  memory: ReputationMemory,
  token: GMGNRawToken,
): VoterReputationContext | null {
  const deployer = typeof token.deployer === 'string' ? token.deployer.trim() : '';
  if (!deployer) return null;

  const snapshot: AegisSnapshot = {
    mintAuthority: !token.renouncedMint,
    freezeAuthority: !token.renouncedFreeze,
    topHolderConcPct: typeof token.top10HolderRate === 'number' ? Math.round(token.top10HolderRate * 100) : 0,
    bundleDetected: (token.bundlerRate ?? 0) >= 0.3,
    lpStatus: token.creatorClose ? 'none' : 'locked',
    metadataFlags: token.creatorClose,
  };

  const profile: WalletProfile = {
    ageDays:
      typeof token.creationTimestamp === 'number'
        ? Math.max(0, (Date.now() - token.creationTimestamp * 1000) / 86_400_000)
        : 0,
    historyCount: 0,
  };

  return { memory, deployer, profile, snapshot };
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

/**
 * Helper: security vote is fail-closed — 0 on audit failure, 100 on pass.
 * `penalties` (rug features, holder concentration) subtract 10 each; `botRisk`
 * (0-100, from BotDetectionService) applies a scaled safety demerit on top.
 */
export function securityVote(auditPassed: boolean, penalties: string[] = [], botRisk = 0): VoterOpinion {
  if (!auditPassed) {
    return { voter: 'security', score: 0, reasons: ['security audit failed — fail-closed'] };
  }
  let score = 100 - penalties.length * 10;
  const reasons = penalties.length > 0 ? [...penalties] : ['audit passed'];
  if (botRisk > 0) {
    const demerit = botRisk >= 80 ? 30 : botRisk >= 60 ? 20 : botRisk >= 40 ? 10 : 5;
    score -= demerit;
    reasons.push(`bot-risk ${Math.round(botRisk)}`);
  }
  return { voter: 'security', score: Math.max(0, score), reasons };
}

/**
 * Helper: whale vote from GMGN smart-money/KOL flow — accumulation lifts,
 * heavy sells/full-closes cap it. `botRisk` (0-100) CAPS accumulation evidence:
 * bot-driven flow is untrustworthy, so a high bot risk floors the whale score
 * even if the trade feed shows heavy buying.
 */
export interface WhaleEnrichment {
  /** 0-100 per-token wallet-score (Q03) — blend, neutral when absent. */
  walletScore?: number;
  /** 0-100 accumulation convergence (Q05) — blend, neutral when absent. */
  convergence?: number;
}

export function whaleVote(
  trades: VoterContext['trackTrades'] = [],
  botRisk = 0,
  enrichment: WhaleEnrichment = {}
): VoterOpinion {
  if (!trades || trades.length === 0) {
    const reasons = botRisk >= 60 ? [`bot risk ${Math.round(botRisk)} — flow not trusted`] : ['no smart-money flow data — neutral'];
    return {
      voter: 'whale',
      score: botRisk >= 60 ? 40 : 50,
      reasons,
    };
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
  // Q03/Q05 enrichment: blend towards the wallet-score / convergence read when
  // supplied. Missing/NaN inputs never shift the vote (fail-closed).
  const supp: number[] = [];
  if (typeof enrichment.walletScore === 'number' && Number.isFinite(enrichment.walletScore)) {
    supp.push(Math.max(0, Math.min(100, enrichment.walletScore)));
    reasons.push(`wallet score ${Math.round(enrichment.walletScore)}`);
  }
  if (typeof enrichment.convergence === 'number' && Number.isFinite(enrichment.convergence)) {
    supp.push(Math.max(0, Math.min(100, enrichment.convergence)));
    reasons.push(`flow convergence ${Math.round(enrichment.convergence)}`);
  }
  let blended = finalScore;
  if (supp.length > 0) {
    const suppAvg = supp.reduce((a, b) => a + b, 0) / supp.length;
    blended = Math.round(finalScore * 0.5 + suppAvg * 0.5);
  }
  blended = Math.max(0, Math.min(100, blended));
  let capped = finalScore;
  if (supp.length > 0) capped = blended;
  if (botRisk >= 60) {
    capped = Math.min(capped, 40);
    reasons.push(`bot risk ${Math.round(botRisk)} caps accumulation read`);
  } else if (botRisk >= 40) {
    capped = Math.min(capped, 55);
    reasons.push(`bot risk ${Math.round(botRisk)} limits accumulation read`);
  }
  return { voter: 'whale', score: capped, reasons };
}

/** Build a full VoterScores map from opinions that actually rendered. */
export function scoresFromOpinions(opinions: VoterOpinion[]): VoterScores {
  const out: VoterScores = {};
  for (const o of opinions) out[o.voter] = o.score;
  return out;
}

/**
 * Q03 wallet vote: HIGHER wallet-score => HIGHER 0-100 vote (monotonic).
 * Missing/NaN inputs degrade to neutral 50 — never a false win (fail-closed).
 */
export function walletVote(ctx: VoterContext): VoterOpinion {
  if (!ctx.walletMetrics) {
    return { voter: 'wallet', score: 50, reasons: ['wallet metrics missing — neutral'] };
  }
  const res = walletScore(ctx.walletMetrics);
  const finite = Number.isFinite(res.score);
  if (!finite || res.degraded) {
    return {
      voter: 'wallet',
      score: 50,
      reasons: [...res.reasons, 'wallet score degraded/missing — neutral (fail-closed)'],
    };
  }
  return {
    voter: 'wallet',
    score: Math.max(0, Math.min(100, Math.round(res.score))),
    reasons: res.reasons,
  };
}

/** Kernel A wiring: wallet vote with deployer reputation read. Fail-closed on degraded/known-rugged reads. */
export function reputationAwareWalletVote(ctx: VoterContext): VoterOpinion {
  const rep = ctx.reputation;
  if (!ctx.walletMetrics || !rep) return walletVote(ctx);

  const tokenId =
    typeof ctx.token.address === 'string' && ctx.token.address.length > 0
      ? ctx.token.address
      : `${ctx.chain}:${ctx.token.symbol ?? 'TOKEN'}`;
  const res = walletScoreWithReputation(
    ctx.walletMetrics,
    rep.memory,
    tokenId,
    rep.deployer,
    rep.profile,
    rep.snapshot,
  );

  const knownRugged = rep.memory.deployerKnown(rep.deployer) === 'rugged';
  if (res.degraded || knownRugged || res.tag === 'KNOWN_RUGGER') {
    return {
      voter: 'wallet',
      score: 50,
      reasons: [
        ...res.reasons,
        knownRugged ? 'KNOWN_RUGGER deployer — neutral (fail-closed)' : 'reputation/wallet read not trustworthy — neutral (fail-closed)',
      ],
    };
  }

  return {
    voter: 'wallet',
    score: Math.max(0, Math.min(100, Math.round(res.score))),
    reasons: res.reasons,
  };
}

/** Kernel A wiring: security vote with known-rugged / below-floor deployer reputation read. */
export function reputationAwareSecurityVote(
  auditPassed: boolean,
  reputation: ReputationMemory,
  token: string,
  deployer: string,
  snapshot: AegisSnapshot,
  penalties: string[] = [],
  botRisk = 0,
): VoterOpinion {
  if (!auditPassed) return securityVote(false, penalties, botRisk);

  const known = reputation.deployerKnown(deployer);
  const adjusted = reputation.reputationAdjustment(token, deployer, snapshot);
  if (known === 'rugged') {
    return {
      voter: 'security',
      score: 0,
      reasons: [...penalties, 'known-rugged deployer — fail-closed'],
    };
  }
  if (adjusted.score < 60) {
    return {
      voter: 'security',
      score: 0,
      reasons: [...penalties, ...adjusted.evidence, 'reputation below floor — fail-closed'],
    };
  }

  const base = securityVote(true, penalties, botRisk);
  return {
    voter: 'security',
    score: base.score,
    reasons: [...base.reasons, ...adjusted.evidence],
  };
}

/**
 * Q05 convergence vote: N DISTRIBUTED accumulating wallets raise the score;
 * a single dominant whale is NOT convergence (neutral). Stale/sparse windows
 * are neutral — never a false positive.
 */
export function convergenceVote(ctx: VoterContext): VoterOpinion {
  const data = ctx.convergence;
  if (!data || !Array.isArray(data.buys) || data.buys.length === 0) {
    return { voter: 'convergence', score: 50, reasons: ['no convergence flow data — neutral'] };
  }
  const res = flowConvergenceScore(data.buys, data.config, data.now);
  const finite = Number.isFinite(res.score);
  if (!finite) {
    return { voter: 'convergence', score: 50, reasons: res.reasons };
  }
  return {
    voter: 'convergence',
    score: Math.max(0, Math.min(100, Math.round(res.score))),
    reasons: res.reasons,
  };
}

/**
 * Q12 rubric vote: weighted security rubric from concentration/spike/vol/liquidity.
 * A missing REQUIRED factor means the rubric is NOT clean — fail closed to
 * neutral 50 (never a confident read on incomplete data). Concentration/spike
 * move the score.
 */
export function rubricVote(ctx: VoterContext): VoterOpinion {
  if (!ctx.rubricMetrics) {
    return { voter: 'rubric', score: 50, reasons: ['rubric metrics missing — neutral'] };
  }
  const factors = securityMetricFactors(ctx.rubricMetrics);
  const rubric = computeRubric(factors);
  if (!rubric.clean) {
    const missing = rubric.factors.filter((f) => f.missing).map((f) => f.name);
    return {
      voter: 'rubric',
      score: 50,
      reasons: [`missing required factor(s): ${missing.join(', ')}`, 'rubric not clean — neutral (fail-closed)'],
    };
  }
  return {
    voter: 'rubric',
    score: rubric.overall,
    reasons: rubric.factors.map((f) => `${f.name}: ${f.score01.toFixed(2)}`),
  };
}

export interface StickyQuantVoteOptions {
  key: string;
  reasons?: string[];
  priceMovePct?: number;
  ttlMs?: number;
  price?: number;
}

/** Cache-aware quant voter (A16 sticky conviction): keeps the last 0-100 conviction until TTL / price move expires it. */
export async function stickyQuantVote(
  cache: DecisionCache,
  signalConfidence: number,
  opts: StickyQuantVoteOptions
): Promise<VoterOpinion> {
  const sticky = await cache.getSticky<number>(
    opts.key,
    () => Math.max(0, Math.min(100, signalConfidence)),
    { priceMovePct: opts.priceMovePct, ttlMs: opts.ttlMs, price: opts.price },
  );
  return quantVote(sticky ?? Math.max(0, Math.min(100, signalConfidence)), opts.reasons ?? []);
}

export interface ImmutableSecurityVoteOptions {
  key: string;
  ttlMs: number;
  penalties?: string[];
  botRisk?: number;
}

/**
 * Cache-aware security voter (Million one-way door): the first successfully
 * resolved audit/DNA fact is kept forever even if a later check disagrees.
 */
export async function immutableSecurityVote(
  cache: DecisionCache,
  validator: () => Promise<boolean>,
  opts: ImmutableSecurityVoteOptions
): Promise<VoterOpinion> {
  const auditPassed = await cache.getImmutable<boolean>(opts.key, validator, opts.ttlMs);
  return securityVote(auditPassed === true, opts.penalties ?? [], opts.botRisk ?? 0);
}

/** Cache-aware convergence voter (Million owner-id dedup): one actor's N wallets count as one confirmation. */
export async function ownerDedupedConvergenceVote(
  cache: DecisionCache,
  ctx: VoterContext
): Promise<VoterOpinion> {
  const data = ctx.convergence;
  if (!data || !Array.isArray(data.buys) || data.buys.length === 0) return convergenceVote(ctx);

  const seen = new Set<string>();
  const deduped: BuyEvent[] = [];
  for (const buy of data.buys) {
    const owners = await cache.dedupByOwner([buy.wallet]);
    const owner = owners[0] ?? buy.wallet;
    const key = owner.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...buy, wallet: owner });
  }

  return convergenceVote({ ...ctx, convergence: { ...data, buys: deduped } });
}
