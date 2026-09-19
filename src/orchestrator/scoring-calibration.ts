/**
 * Q10 - Scoring calibration (IC-weight learning + Platt + regime abstain +
 * walk-forward validation), validated through the Q01 harness. Pure and
 * deterministic so it can be unit-tested and dry-run through the harness.
 */

export interface CalibrationRow {
  /** Voter id → raw 0-100 score rendered for this outcome. */
  voterScores: Record<string, number>;
  /** Realized label: 1 = win/success, 0 = loss. */
  realized: number;
  timestamp?: number;
}

export interface ICResult {
  /** Pearson r per voter between their scores and the realized label. */
  ics: Record<string, number>;
  /** Weight deltas proportional to each voter's IC. */
  deltas: Record<string, number>;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    syy += ys[i] * ys[i];
    sxy += xs[i] * ys[i];
  }
  const denomX = n * sxx - sx * sx;
  const denomY = n * syy - sy * sy;
  if (denomX === 0 || denomY === 0) return 0;
  return (n * sxy - sx * sy) / Math.sqrt(denomX * denomY);
}

/** Compute Information-Coefficient (Pearson) per voter against the labels. */
export function voterICs(rows: CalibrationRow[], voters: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const voter of voters) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const row of rows) {
      const s = row.voterScores[voter];
      if (typeof s === 'number' && Number.isFinite(s)) {
        xs.push(s);
        ys.push(row.realized);
      }
    }
    out[voter] = pearson(xs, ys);
  }
  return out;
}

const IC_STEP = 0.05;

/**
 * Weight deltas proportional to each voter's IC (higher-IC voters get larger
 * deltas). `base` weights are adjusted within [0.02, 0.5] to stay sane.
 */
export function icWeightDeltas(
  rows: CalibrationRow[],
  voters: string[],
  base: Record<string, number>
): ICResult {
  const ics = voterICs(rows, voters);
  const deltas: Record<string, number> = {};
  for (const v of voters) {
    deltas[v] = ics[v] * IC_STEP;
  }
  return { ics, deltas };
}

export function applyDeltas(base: Record<string, number>, deltas: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...base };
  for (const k of Object.keys(deltas)) {
    out[k] = Math.max(0.02, Math.min(0.5, (out[k] ?? 0) + deltas[k]));
  }
  return out;
}

/**
 * Platt calibration: sigmoid maps a raw [0,1] score to a probability in (0,1).
 * Rank-preserving whenever `a > 0` (monotonic increasing in score01).
 */
export function plattCalibrate(score01: number, a: number, b: number): number {
  if (!Number.isFinite(score01)) return 0.5;
  const clamped = Math.max(0, Math.min(1, score01));
  const z = a * clamped + b;
  const p = 1 / (1 + Math.exp(-z));
  return Math.max(0, Math.min(1, p));
}

export interface RegimeState {
  abstain?: boolean;
}

/** When a regime is abstain-critical, return a neutral vote (never a win). */
export function abstainNeutral(regime: RegimeState | null | undefined): { abstain: boolean; neutralScore: number } {
  if (!regime?.abstain) return { abstain: false, neutralScore: 50 };
  return { abstain: true, neutralScore: 50 };
}

export interface WalkForwardSplit {
  train: CalibrationRow[];
  validation: CalibrationRow[];
}

/**
 * Time-ordered walk-forward split. Rows are sorted by timestamp ascending; the
 * last `1/folds` become validation so the validation fold never leaks training
 * data (train is strictly earlier in time).
 */
export function walkForwardSplit(rows: CalibrationRow[], folds = 5): WalkForwardSplit {
  const ordered = [...rows].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const valSize = Math.max(1, Math.floor(ordered.length / folds));
  const splitAt = Math.max(0, ordered.length - valSize);
  return { train: ordered.slice(0, splitAt), validation: ordered.slice(splitAt) };
}
