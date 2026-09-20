/**
 * PR 2 / Kernel E — typed `Result<T,E>` for the EVM adapter (SRC-039 PELLET:
 * throw-free adapter contract + ordered first-fail risk-gatechain; SRC-261
 * FLYWHEEL: clamp-before-trust sizing).
 *
 * Additive: adapters may keep throwing for now; callers are migrated to Result
 * and the throw-based `callLegacy` shim is removed at the end of the deprecation
 * window (G2). Nothing here touches network, config, or secrets.
 */

export interface AdapterError {
  code: string;
  message: string;
  retryable: boolean;
  host?: string;
}

export type Result<T, E = AdapterError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T, E = AdapterError>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<T, E = AdapterError>(error: E): Result<T, E> {
  return { ok: false, error };
}

/** Unwrap a Result, throwing the wrapped error when it is err. */
export function unwrap<T, E = AdapterError>(r: Result<T, E>): T {
  if (!r.ok) {
    const e = r.error;
    throw e instanceof Error ? e : new Error((e as { message?: string } | null)?.message ?? String(e));
  }
  return r.value;
}

/**
 * FLYWHEEL fail-safe sizing: clamp a model-returned size to its cap before
 * trusting it. A non-finite size is an explicit veto, never a zero-stake buy.
 */
export function clampSize(raw: number, max: number): Result<number, AdapterError> {
  if (!Number.isFinite(raw) || Number.isNaN(raw)) {
    return err({ code: 'OVERRIDE_INVALID', message: 'model-returned size is not a finite number', retryable: false });
  }
  const effectiveMax = max > 0 ? max : Number.POSITIVE_INFINITY;
  return ok(Math.min(Math.max(raw, 0), effectiveMax));
}

/**
 * PELLET ordered first-fail risk-gatechain. Runs steps in order and returns on
 * the FIRST failure; resolves ok only when every step passes.
 */
export async function firstFail(
  steps: Array<() => Promise<Result<unknown, AdapterError>>>
): Promise<Result<true, AdapterError>> {
  for (const step of steps) {
    const r = await step();
    if (!r.ok) return r;
  }
  return ok(true as const);
}
