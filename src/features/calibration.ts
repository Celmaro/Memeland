/**
 * P14 — Calibration: turn rawScore (additive 0-100 heuristic) into a real P(win).
 *
 * #5 established that rawScore and calibratedProbability are DISTINCT and that a
 * fabricated probability is worse than none — hence `null` until a live model is
 * wired. P14 wires it: a histogram-binning calibrator fit over durable LABELED
 * outcomes (closed paper trades: realizedPnlPct > 0 ⇒ won). Once enough labels
 * exist per score bucket it emits P(win | score, horizon) in [0,1]; below the
 * sample floor it returns null (back-compat, never fabricates).
 *
 * The label source is the durable paper ledger (P8) — closed trades are the
 * ground truth. The global model seeds from it on boot, so it is rebuildable
 * across restarts without duplicating storage.
 */

import { loadPaperTrades } from '../services/paper-trading.js';

export interface CalibrationSample {
  /** The additive heuristic score that produced the decision (0-100). */
  rawScore: number;
  /** Ground-truth label: did the trade win (realizedPnlPct > 0). */
  won: boolean;
}

export interface CalibrationOptions {
  /** Distinct rawScore buckets across 0-100 (default 10). */
  binCount?: number;
  /** Minimum total labeled samples before any probability is emitted (default 30). */
  minTotalSamples?: number;
  /** Minimum samples in a bucket before that bucket's probability is trusted (default 3). */
  minSamplesPerBin?: number;
}

export class CalibrationModel {
  private samples: CalibrationSample[] = [];
  private bins = new Map<number, { wins: number; total: number }>();
  private readonly binCount: number;
  private readonly minTotalSamples: number;
  private readonly minSamplesPerBin: number;

  constructor(opts: CalibrationOptions = {}) {
    this.binCount = opts.binCount ?? 10;
    this.minTotalSamples = opts.minTotalSamples ?? 30;
    this.minSamplesPerBin = opts.minSamplesPerBin ?? 3;
  }

  /** Ingest one labeled outcome. */
  public ingest(rawScore: number, won: boolean): void {
    const s: CalibrationSample = { rawScore, won };
    this.samples.push(s);
    const bin = this.binOf(rawScore);
    const b = this.bins.get(bin) ?? { wins: 0, total: 0 };
    b.total += 1;
    if (won) b.wins += 1;
    this.bins.set(bin, b);
  }

  /** Derive labels from closed paper trades (realizedPnlPct > 0 ⇒ won; confidence ⇒ rawScore). */
  public seedFromPaperTrades(closed: ReadonlyArray<{ confidence?: number; realizedPnlPct?: number }>): void {
    for (const t of closed) {
      if (typeof t.confidence !== 'number' || typeof t.realizedPnlPct !== 'number') continue;
      this.ingest(t.confidence, t.realizedPnlPct > 0);
    }
  }

  /** Number of labeled samples ingested. */
  public sampleCount(): number {
    return this.samples.length;
  }

  /**
   * Calibrated P(win | rawScore). Returns null (never a fabricated number) when
   * the global sample floor or the specific score-bucket floor is not met.
   */
  public probability(rawScore: number): number | null {
    if (this.samples.length < this.minTotalSamples) return null;
    const b = this.bins.get(this.binOf(rawScore));
    if (!b || b.total < this.minSamplesPerBin) return null;
    return (b.wins + 1) / (b.total + 2); // Laplace smoothing → strictly in (0,1)
  }

  /** Durable snapshot of all labeled samples (for inspection/hydration). */
  public snapshot(): CalibrationSample[] {
    return [...this.samples];
  }

  /**
   * Rebuild the model from a sample history after a restart. Applies only when the
   * model is empty this process, so it never clobbers live ingestion.
   */
  public hydrate(samples: CalibrationSample[]): void {
    if (this.samples.length > 0) return;
    for (const s of samples) {
      if (Number.isFinite(s.rawScore)) this.ingest(s.rawScore, !!s.won);
    }
  }

  /** The histogram bucket (0..binCount-1) a rawScore falls into. */
  private binOf(rawScore: number): number {
    const clamped = Math.max(0, Math.min(100, rawScore));
    const width = 100 / this.binCount;
    return Math.min(this.binCount - 1, Math.floor(clamped / width));
  }
}

/**
 * Create the default calibration model, seeded from the durable paper ledger (P8):
 * closed paper trades provide (confidence, realizedPnlPct) labels. Best-effort and
 * asynchronous; the model emits probabilities once enough labels accumulate.
 */
export function createDefaultCalibrationModel(): CalibrationModel {
  const model = new CalibrationModel();
  void loadPaperTrades()
    .then((trades) => model.seedFromPaperTrades(trades.filter((t) => t.status !== 'OPEN')))
    .catch(() => { /* seeding is best-effort */ });
  return model;
}

/** Process-wide calibration model for the screening cycle (seeded from the durable paper ledger). */
export const globalCalibrationModel = createDefaultCalibrationModel();
