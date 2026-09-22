/**
 * KC2 / Kernel M — generic paced HTTP client (replaces the GMGN + LI.FI
 * `requestQueue` + `lastRequestAt` pattern). Module-level queue — one
 * process-wide lane per PacedHttpClient instance, configurable spacing,
 * injectable fetch + clock. Adapters compose the result with their own
 * headers, retry, and key-pool layers above it.
 */

export interface PacedHttpClientOptions {
  /** Minimum gap (ms) between consecutive requests on this client. */
  baseSpacingMs: number;
  /** Injectable fetch — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock — defaults to Date.now. */
  now?: () => number;
  /** Optional logger for the network-error / non-ok cases. */
  logger?: (msg: string) => void;
}

/**
 * Serialises HTTP requests with a configurable minimum spacing. The first
 * request goes through immediately; subsequent requests are queued and
 * released only when the spacing window has elapsed. The queue is awaited
 * by every caller so two adapters cannot race past the same gate.
 *
 * Returns `null` on network error or non-ok HTTP status — same fail-closed
 * semantics both adapters (GMGN, LI.FI) used before this kernel.
 */
export class PacedHttpClient {
  private readonly baseSpacingMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly logger?: (msg: string) => void;

  /** Promise-queue tail — every paced call awaits the previous one. */
  private tail: Promise<void> = Promise.resolve();
  /** Wall-clock time the last call actually started (NOT scheduled). */
  private lastStartedAt = 0;

  constructor(opts: PacedHttpClientOptions) {
    if (!(opts.baseSpacingMs > 0)) throw new Error('PacedHttpClient: baseSpacingMs must be > 0');
    this.baseSpacingMs = opts.baseSpacingMs;
    this.fetchImpl = opts.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    if (opts.logger) this.logger = opts.logger;
  }

  /** Issue `url` + `init` with at least `baseSpacingMs` since the previous call. */
  public async pacedFetch(url: string, init?: RequestInit): Promise<Response | null> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await prev;
    try {
      const wait = Math.max(0, this.lastStartedAt + this.baseSpacingMs - this.now());
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      this.lastStartedAt = this.now();
      return await this.doFetch(url, init);
    } finally {
      release();
    }
  }

  /** Force a spacing reset (e.g. after a 429 backoff). */
  public resetSpacing(): void {
    this.lastStartedAt = 0;
  }

  private async doFetch(url: string, init?: RequestInit): Promise<Response | null> {
    try {
      const res = await this.fetchImpl(url, init);
      if (!res.ok) {
        this.logger?.(`[PacedHttpClient] ${url} HTTP ${res.status}`);
        return null;
      }
      return res;
    } catch (err: unknown) {
      this.logger?.(`[PacedHttpClient] ${url} network error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}