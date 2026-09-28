/**
 * #2 — Offline calibration harness: earn the floor number.
 *
 * The 80% floor was asserted, not measured. The calibration loop (swarm-
 * learning) needs realized outcomes → fires → a calibrated gate — structurally
 * starved. This harness replays historical signal candidates through the
 * current swarm OFFLINE and measures threshold vs. follow-through, so the
 * floor becomes evidence-based instead of assumed.
 *
 * Pipeline:
 *  1. Read signal-ledger entries (StateStore) — each has rawPayloadJson with
 *     the candidate (incl. voterScores) + confidenceScore + passed.
 *  2. Label follow-through: the caller supplies a `labelFollowThrough` fn
 *     (e.g. klines-after-signal from Gecko/GMGN, or scorecard TP/SL for fired
 *     signals). Unknown label → excluded (never counted as a false fire).
 *  3. For each candidate threshold T in [50..95]:
 *       precision = #follow-through among score>=T / #score>=T
 *       recall    = #follow-through among score>=T / total follow-through
 *  4. Recommend a floor: the highest T with precision >= minPrecision AND
 *     recall >= minRecall (defaults 0.15 / 0.3), capped at 90 — the number is
 *     earned from data, never convenience-lowered.
 *
 * Pure + deterministic; no network calls in this module (the labeler does I/O).
 */

import type { StateStore } from '../services/state-store.js';
import type { TradeJournalEntry } from '../services/trade-journal-service.js';
import { SwarmConsensusEngine, type SignalCandidate } from './swarm-consensus.js';
import { type OutcomeRow, renderWalkForwardReport } from './walk-forward.js';

export interface CalibrationLabelerInput {
  symbol: string;
  domain: string;
  contractAddress: string;
  /** Ledger stores the final confidence under totalConfidence. */
  totalConfidence: number;
  passed: boolean;
  timestamp: string;
  rawPayloadJson: string;
}

export type FollowThroughLabel = 'up' | 'down' | 'flat' | null;

export interface CalibrationRow {
  symbol: string;
  confidenceScore: number;
  passed: boolean;
  followThrough: FollowThroughLabel;
}

export interface ThresholdResult {
  threshold: number;
  count: number;
  upCount: number;
  precision: number; // 0-1 (0 when no candidates >= T)
  recall: number;    // 0-1 (0 when no follow-through at all)
}

export interface CalibrationReport {
  rows: number;
  labelled: number;
  upTotal: number;
  thresholds: ThresholdResult[];
  recommendedFloor: number | null;
  /** Why the floor was chosen / not chosen. */
  rationale: string;
}

export interface CalibrationHarnessOptions {
  minPrecision?: number;
  minRecall?: number;
  /** Sweep step (default 5). */
  step?: number;
}

/** Load ledger rows from a StateStore and label follow-through. */
export function loadCalibrationRows(
  store: StateStore,
  labelFollowThrough: (input: CalibrationLabelerInput) => FollowThroughLabel,
): CalibrationRow[] {
  const ledger = store.getSignalLedger?.() ?? [];
  const rows: CalibrationRow[] = [];
  for (const entry of ledger as unknown as CalibrationLabelerInput[]) {
    const label = labelFollowThrough(entry);
    if (label === null) continue; // unknown outcome — never counted
    rows.push({
      symbol: entry.symbol,
      confidenceScore: entry.totalConfidence,
      passed: Boolean(entry.passed),
      followThrough: label,
    });
  }
  return rows;
}

/**
 * Sweep thresholds over labelled rows and report precision/recall.
 * `up` = followed through (the positive class).
 */
export function sweepThresholds(rows: CalibrationRow[], opts: CalibrationHarnessOptions = {}): CalibrationReport {
  const minPrecision = opts.minPrecision ?? 0.15;
  const minRecall = opts.minRecall ?? 0.3;
  const step = opts.step ?? 5;

  const upTotal = rows.filter((r) => r.followThrough === 'up').length;
  const thresholds: ThresholdResult[] = [];
  let recommendedFloor: number | null = null;
  let rationale = '';

  for (let t = 50; t <= 95; t += step) {
    const above = rows.filter((r) => r.confidenceScore >= t);
    const upAbove = above.filter((r) => r.followThrough === 'up').length;
    const precision = above.length > 0 ? upAbove / above.length : 0;
    const recall = upTotal > 0 ? upAbove / upTotal : 0;
    thresholds.push({ threshold: t, count: above.length, upCount: upAbove, precision, recall });
  }

  // Earn the floor: highest T meeting BOTH floors, never above 90.
  const candidates = thresholds.filter((t) => t.count > 0 && t.precision >= minPrecision && (upTotal === 0 || t.recall >= minRecall));
  if (candidates.length > 0) {
    recommendedFloor = Math.min(90, candidates[candidates.length - 1]!.threshold);
    rationale =
      `Earned floor ${recommendedFloor}% from ${rows.length} replayed signals ` +
      `(${upTotal} follow-through): highest threshold with precision ≥ ${minPrecision} and recall ≥ ${minRecall}.`;
  } else {
    recommendedFloor = null;
    rationale =
      `No threshold met precision ≥ ${minPrecision} AND recall ≥ ${minRecall} ` +
      `across ${rows.length} replayed signals (${upTotal} follow-through). ` +
      `The gate may be over/under-calibrated — inspect the voter scale or collect more labelled outcomes.`;
  }

  return { rows: rows.length, labelled: rows.length, upTotal, thresholds, recommendedFloor, rationale };
}

/**
 * Backfill labeler (#2): fetch post-signal klines (GeckoTerminal, keyless) and
 * label follow-through — the signal timestamp + 1h window decides up/down/flat.
 * Caller supplies a kline fetcher so tests stay hermetic; the live wiring in
 * index.ts/CLI passes fetchKlinesWithGeckoFallback.
 */
export interface KlineFollowThroughDeps {
  fetchKlines: (chain: string, address: string, hours: number) => Promise<Array<{ timestamp: number; close: number }> | null>;
  /** Signal age in ms; defaults to now. */
  now?: number;
  /** Window (ms) after the signal to measure follow-through (default 1h). */
  windowMs?: number;
  /** Relative move (%) required to call it 'up'/'down' (default 3). */
  movePct?: number;
}

export function klinesFollowThroughLabeler(deps: KlineFollowThroughDeps) {
  return async (input: CalibrationLabelerInput): Promise<FollowThroughLabel> => {
    try {
      const now = deps.now ?? Date.now();
      const windowMs = deps.windowMs ?? 60 * 60 * 1000;
      const movePct = deps.movePct ?? 3;
      const klines = await deps.fetchKlines(input.domain === 'MEME_ROBINHOOD' ? 'bsc' : input.domain, input.contractAddress, 48);
      if (!klines || klines.length < 2) return null;
      const signalAt = Date.parse(input.timestamp);
      if (!Number.isFinite(signalAt)) return null;
      // The signal timestamp may be in the future relative to local now (log
      // clock skew) — clamp so we measure from the signal point, not the wall.
      const target = Math.min(signalAt + windowMs, now);
      const before = klines.filter((k) => k.timestamp <= signalAt);
      const after = klines.filter((k) => k.timestamp <= target && k.timestamp > signalAt);
      if (before.length === 0 || after.length === 0) return null;
      const entry = before[before.length - 1]!.close;
      const exit = after[after.length - 1]!.close;
      if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) return null;
      const change = ((exit - entry) / entry) * 100;
      if (change > movePct) return 'up';
      if (change < -movePct) return 'down';
      return 'flat';
    } catch {
      return null; // klines unavailable → unlabelled (never a false fire)
    }
  };
}

/** Replay a candidate through the CURRENT swarm and return its confidence —
 * used to re-score historical raw payloads with today's voter weights/gates.
 */
export function replayThroughSwarm(candidate: SignalCandidate, engine: SwarmConsensusEngine): { confidenceScore: number; passed: boolean; refusal?: string } {
  const res = engine.evaluateSignal(candidate);
  const refusal = res.decision && 'refusal' in res.decision ? res.decision.refusal : undefined;
  return {
    confidenceScore: res.confidenceScore,
    passed: res.passed,
    refusal,
  };
}

/**
 * P6.1 — Build the walk-forward training dataset from the trade journal.
 * Maps REALIZED trades (status != OPEN with a signed PnL) to OutcomeRow, so the
 * harness measures the same realized outcomes the swarm-learning loop consumes.
 * The journal's `strategyUsed` becomes the strategy tag (BASELINE_V1 | swarm |
 * jev-shadow) so cross-strategy comparison is apples-to-apples. Trades with no
 * terminal PnL yet are excluded — a live position is never counted.
 */
export function buildOutcomeRowsFromJournal(entries: TradeJournalEntry[]): OutcomeRow[] {
  const rows: OutcomeRow[] = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e.status === 'OPEN' || typeof e.realizedPnlPct !== 'number') continue;
    const ts = Date.parse(e.exitTimestamp ?? e.entryTimestamp);
    if (!Number.isFinite(ts)) continue;
    rows.push({
      id: e.id,
      timestamp: ts,
      confidence: e.swarmScore,
      realizedPnlPct: e.realizedPnlPct,
      strategy: e.strategyUsed || 'BASELINE_V1',
    });
  }
  // Chronological by terminal time — the walk-forward split preserves this order.
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * P6.1 — Render the OOS walk-forward report for the given strategies from the
 * trade journal. This is the artifact that must precede ANY live activation
 * (fail-closed: no ROBUST edge → hold activation).
 */
export function walkForwardReportFromJournal(
  entries: TradeJournalEntry[],
  strategies: string[],
  trainFrac?: number,
  valFrac?: number,
): string {
  const rows = buildOutcomeRowsFromJournal(entries);
  return renderWalkForwardReport(rows, strategies, trainFrac, valFrac);
}
