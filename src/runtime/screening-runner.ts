/**
 * KC6 / Kernel Q — ScreeningRunner.
 *
 * This kernel owns the *screening-cycle contract* and the timeout primitive.
 *
 * The full `runScreeningCycle` closure in src/index.ts (~200 lines, ~20
 * module-scope dependencies) is the single live production loop. Per the
 * consolidation plan, full extraction is shadow-mode-only (G7) — this module
 * ships the tested primitive (withScreeningTimeout) plus the ScreeningDeps
 * contract that documents the closure's surface, so a future commit can
 * move the loop body into runScreeningCycle(deps) without re-deriving the
 * dependency list.
 */

export const DEFAULT_SCREENING_TIMEOUT_MS = 60_000;

/**
 * Contract for the screening-cycle dependencies. Each field documents one
 * module-scope binding the live loop in index.ts captures today. A future
 * shadow-mode extraction of runScreeningCycle moves the loop body behind
 * this surface — behaviour must stay byte-for-byte identical (G7).
 */
export interface ScreeningDeps {
  /** Active agent domains to heartbeat + funnel-count. */
  activeDomains(): string[];
  /** Record a heartbeat for a domain (watcher liveness). */
  heartbeat(domain: string): void;
  /** Run one screening pass for a domain, timeout-wrapped. */
  runPass(domain: string): Promise<unknown[]>;
  /** Gate a payload through the Swarm Consensus gate (>= 80%). */
  gate(payload: unknown): boolean;
  /** Dispatch a passed payload to its channel. */
  dispatch(payload: unknown): Promise<{ channelName: string; payload: unknown }[]>;
  /** Funnel counters. */
  funnel: {
    sourcesQueried: number;
    candidatesDiscovered: number;
    candidatesNormalized: number;
    candidatesEnriched: number;
    candidatesRejectedByGate: number;
    signalsEmitted: number;
  };
}

/**
 * Wrap a screening pass with a fail-closed timeout: if the pass exceeds
 * `timeoutMs`, resolve with `[]` (no signals emitted) instead of hanging the
 * cycle. The timer is cleared on settle so the promise never double-resolves.
 *
 * This is the exact semantics of the legacy helper in index.ts, extracted so
 * it is unit-testable and reusable by future runner implementations.
 */
export function withScreeningTimeout<T>(
  promise: Promise<T>,
  domain: string,
  timeoutMs: number = DEFAULT_SCREENING_TIMEOUT_MS,
  log: (msg: string) => void = (msg) => console.warn(msg)
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      log(
        `[SCREENING TIMEOUT] ${domain.toUpperCase()} pass exceeded ${timeoutMs}ms — discarded, no signals emitted (fail-closed).`
      );
      resolve([] as unknown as T);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}