/**
 * PR12.j (SRC-109 HKUDS/Vibe-Trading, Study-later): a fail-closed figure-
 * grounding gate. A decoupled signal ("figure") is only trusted when it is
 * traceable to observable market prints ("ground") that predate the claim and
 * are recent enough to be actionable. This guards against a voter emitting a
 * confident read with no supporting tape. Pure, deterministic, chain-agnostic.
 */

export interface FigureGround {
  at: number;
  value: number;
}

export interface FigureGroundingOptions {
  /** Max age (ms) of a supporting print before it counts as stale. */
  maxStalenessMs?: number;
  /** Minimum number of in-window prints required to ground the figure. */
  minPrints?: number;
}

export interface FigureGroundingResult {
  grounded: boolean;
  supportingPrints: number;
  lastPrintAgeMs: number | null;
  reason: string;
}

/**
 * Verify a figure at `claimAt` is grounded in prior market prints. Only prints
 * with `at` in `[claimAt - maxStalenessMs, claimAt]` count (no look-ahead). The
 * gate requires at least `minPrints` in-window prints and that the most recent
 * one is not stale. Any degenerate input fails closed.
 */
export function figureGroundingGate(
  ground: FigureGround[],
  claimAt: number,
  options: FigureGroundingOptions = {},
): FigureGroundingResult {
  const maxStalenessMs =
    Number.isFinite(options.maxStalenessMs) ? (options.maxStalenessMs as number) : 3600_000;
  const minPrints = Number.isFinite(options.minPrints) ? Math.max(1, options.minPrints as number) : 1;
  const prints = (Array.isArray(ground) ? ground : []).filter(
    (g) => g && Number.isFinite(g.at) && Number.isFinite(g.value),
  );

  if (prints.length === 0 || !Number.isFinite(claimAt)) {
    return {
      grounded: false,
      supportingPrints: 0,
      lastPrintAgeMs: null,
      reason: 'no market prints to ground the figure — fail-closed',
    };
  }

  const inWindow = prints.filter((g) => g.at >= claimAt - maxStalenessMs && g.at <= claimAt);
  const supportingPrints = inWindow.length;
  const lastInWindow = inWindow.length > 0 ? inWindow[inWindow.length - 1] : null;
  const lastPrintAgeMs = lastInWindow ? claimAt - lastInWindow.at : null;

  if (supportingPrints < minPrints) {
    return {
      grounded: false,
      supportingPrints,
      lastPrintAgeMs,
      reason: `only ${supportingPrints} supporting print(s); need ${minPrints}`,
    };
  }
  return {
    grounded: true,
    supportingPrints,
    lastPrintAgeMs,
    reason: `grounded by ${supportingPrints} in-window print(s)`,
  };
}
