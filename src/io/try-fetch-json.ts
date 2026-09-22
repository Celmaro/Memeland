/**
 * KC3 / Kernel N — tryFetchJson — the most-repeated adapter boilerplate:
 *
 *   const res = await fetch(url, init);
 *   if (!res.ok) { warn(...); return null; }
 *   try { return await res.json(); } catch { warn(...); return null; }
 *
 * Returns `null` on:
 *   - network error (fetch throws)
 *   - non-ok HTTP status (4xx/5xx; logs the status via opts.logger)
 *   - response.json() parse error (logs the error via opts.logger)
 *
 * Returns the parsed JSON body otherwise. The caller never has to wrap
 * its own try/catch around fetch for normal failure semantics.
 */

export interface TryFetchJsonOptions {
  /** Injectable fetch (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
  /** Optional logger used for the three failure modes. */
  logger?: (msg: string) => void;
  /** Optional AbortSignal threaded into the underlying fetch. */
  signal?: AbortSignal;
  /**
   * When set, the logger receives the response body slice (truncated) on
   * non-ok status. Useful when the caller wants to surface provider-specific
   * error payloads (LI.FI / GMGN both return JSON {code, message}).
   */
  includeErrorBody?: boolean;
}

export async function tryFetchJson<T>(
  url: string,
  init?: RequestInit,
  opts: TryFetchJsonOptions = {}
): Promise<T | null> {
  const fetchImpl = opts.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch ?? fetch;
  const logger = opts.logger;
  const signal = opts.signal ?? init?.signal;

  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, ...(signal ? { signal } : {}) });
  } catch (err: unknown) {
    logger?.(`[tryFetchJson] ${url} network error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!res.ok) {
    if (logger && opts.includeErrorBody) {
      try {
        const text = (await res.text()).slice(0, 300);
        logger?.(`[tryFetchJson] ${url} HTTP ${res.status}: ${text}`);
        return null;
      } catch { /* fall through to status-only log */ }
    }
    logger?.(`[tryFetchJson] ${url} HTTP ${res.status}`);
    return null;
  }
  try {
    return (await res.json()) as T;
  } catch (err: unknown) {
    logger?.(`[tryFetchJson] ${url} json parse error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}