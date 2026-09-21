export type FailureMode = 'fail-closed' | 'fail-open-empty' | 'stale-cache-only' | 'retry-then-veto';

export interface RetryPolicy {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (attempt: number, error: unknown) => boolean;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (typeof status === 'number') return isRetryableStatus(status);
  return false;
}

export async function callWithRetry<T>(
  execute: () => Promise<T>,
  policy: RetryPolicy = {},
  onRetry?: (error: unknown, attempt: number) => void,
): Promise<T> {
  const attempts = Math.max(1, policy.attempts ?? 3);
  const baseDelayMs = policy.baseDelayMs ?? 100;
  const maxDelayMs = policy.maxDelayMs ?? 1000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await execute();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !(policy.shouldRetry ? policy.shouldRetry(attempt, error) : isRetryableError(error))) {
        break;
      }
      onRetry?.(error, attempt);
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

export function failureValue<T>(mode: FailureMode, fallback: T | undefined, error: unknown): T {
  if (mode === 'fail-open-empty' || mode === 'stale-cache-only') {
    return fallback as T;
  }
  if (error instanceof Error) throw error;
  throw new Error(`Call failed under ${mode}: ${String(error)}`);
}
