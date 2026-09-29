/**
 * Pass-timing telemetry (P1 — "measure, don't guess").
 *
 * The screening pass used to be a monolithic await that either completed inside
 * SCREENING_TIMEOUT_MS or got discarded with no visibility into WHERE it spent
 * the time. This tiny helper wraps the expensive awaits inside runScreeningPass
 * and emits a [PASS TIMING] line per stage, so the operator can see exactly
 * which chain/stage dominates (native price vs discovery vs hint verify vs
 * enrichment) instead of guessing. Telemetry only — no behavior change.
 */

/**
 * Wrap a promise (or sync fn) and emit a `[PASS TIMING] stage=<name> ms=N` line
 * when it settles. Heavy stages (>=1000ms) always print; cheap stages print only
 * under LOG_VERBOSE=true so the default Zeabur log stays clean. Telemetry, never
 * a gate — an injected clock makes tests deterministic.
 */
export async function timed<T>(
  name: string,
  fn: () => Promise<T> | T,
  opts: { now?: () => number } = {},
): Promise<T> {
  const now = opts.now ?? (() => Date.now());
  const start = now();
  try {
    return await fn();
  } finally {
    const ms = now() - start;
    if (ms >= 1000 || process.env.LOG_VERBOSE === 'true') {
      console.log(`[PASS TIMING] stage=${name} ms=${ms}`);
    }
  }
}