export interface ApiKeyPool {
  readonly baseVar: string;
  readonly keys: string[];
  readonly size: number;
  get(): string | undefined;
  markFailed(reason: string): string | undefined;
  reset(): void;
  getMaskedList(): string[];
}

/** Options for {@link fetchWithKeyPool}. */
export interface FetchWithKeyPoolOptions {
  /** Log label prefix. Used only for the rotation warning. */
  label: string;
  /** HTTP statuses that are treated as key-retryable (rotate + retry). Default `[401,402,403,429]`. */
  retryStatuses?: readonly number[];
  /** Max loop iterations. Default `Math.max(1, pool.size)`. */
  maxAttempts?: number;
  /** Optional reason string used for logging the rotation. Default maps 402/429 specially. */
  reasonFor?: (status: number) => string;
  /** When true and the pool is empty, issue a single keyless request (used by GoPlus). Default false. */
  allowEmptyPool?: boolean;
}

function defaultReasonForStatus(status: number): string {
  if (status === 402) return 'HTTP 402 (No credit left)';
  if (status === 429) return 'HTTP 429 (Rate limited)';
  return `HTTP ${status}`;
}

/**
 * Run a fetch against the active pool key, rotating to backup keys on the
 * retryable auth/rate statuses (401/402/403/429). Encapsulates the loop that
 * was previously copy-pasted across the adapters:
 *
 * - Empty pool → fail-closed `null` (unless `allowEmptyPool`, then one keyless attempt).
 * - `build(key)` returns a `Response`; `ok` → returned immediately.
 * - Retryable status + `size > 1` → `markFailed` + retry with the next key.
 * - Any other non-ok response → returned as-is (caller decides).
 * - Fetch throws → `null` (fail-closed; no fabricated data).
 * - All keys exhausted → the last response (callers already treat `!ok` as failure).
 *
 * @returns the winning `Response`, a non-ok `Response`, the last `Response`
 *   after exhausting every key, or `null` on empty pool / network error.
 */
export async function fetchWithKeyPool(
  pool: ApiKeyPool,
  build: (key: string) => Promise<Response>,
  opts: FetchWithKeyPoolOptions
): Promise<Response | null> {
  const retryStatuses = opts.retryStatuses ?? [401, 402, 403, 429];
  const maxAttempts = opts.maxAttempts ?? Math.max(1, pool.size);
  const reasonFor = opts.reasonFor ?? defaultReasonForStatus;
  if (pool.size === 0) {
    if (!opts.allowEmptyPool) return null;
    try {
      return await build('');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`${opts.label} Request error: ${message}`);
      return null;
    }
  }

  let attempts = 0;
  let last: Response | null = null;

  while (attempts < maxAttempts) {
    const key = pool.get() || '';
    if (!key) return null;
    try {
      const res = await build(key);
      last = res;
      if (res.ok) return res;
      if (retryStatuses.includes(res.status) && pool.size > 1) {
        const reason = reasonFor(res.status);
        console.warn(`${opts.label} Key failed: ${reason} - rotating to backup key...`);
        pool.markFailed(reason);
        attempts++;
        continue;
      }
      return res;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`${opts.label} Request error: ${message}`);
      return null;
    }
  }
  return last;
}

const PLACEHOLDER_RE = /YOUR_|placeholder|mock/i;

export function createApiKeyPool(baseVar: string, keys: string[]): ApiKeyPool {
  const clean = keys
    .flatMap((k) => (typeof k === 'string' ? k.split(',') : []))
    .map((k) => k.trim())
    .filter((k) => k && !PLACEHOLDER_RE.test(k));
  let index = 0;
  let failed = new Set<number>();

  return {
    baseVar,
    keys: clean,
    size: clean.length,
    get(): string | undefined {
      return clean[index] ?? undefined;
    },
    markFailed(reason: string): string | undefined {
      if (clean.length <= 1) return clean[0] ?? undefined;
      failed.add(index);
      if (failed.size >= clean.length) {
        failed = new Set();
        console.warn(`[API KEY POOL] ${baseVar}: all keys failed — rotation reset.`);
      }
      let next = index;
      do {
        next = (next + 1) % clean.length;
      } while (failed.has(next) && failed.size < clean.length);
      index = next;
      console.warn(`[API KEY POOL] ${baseVar}: rotating to key #${index + 1}/${clean.length} (${reason}).`);
      return clean[index] ?? undefined;
    },
    reset(): void {
      failed = new Set();
      index = 0;
    },
    getMaskedList(): string[] {
      return clean.map((k, i) => {
        const masked = k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : `${k.slice(0, 2)}***`;
        return `#${i + 1}: ${masked}${i === index ? ' (active)' : ''}`;
      });
    },
  };
}

export function loadApiKeyPool(baseVar: string, aliases: string[] = []): ApiKeyPool {
  const candidates: string[] = [];
  const primaryKeys = [baseVar, ...aliases];

  for (const varName of primaryKeys) {
    const val = process.env[varName];
    if (val) candidates.push(val);
  }

  // Comprehensive backup key patterns:
  // e.g. GMGN_API_KEY -> GMGN_API_KEY_BACKUP_KEYS, GMGN_BACKUP_KEYS, GMGN_API_KEY_BACKUP, GMGN_BACKUP, GMGN_KEY_1..10
  const prefixes = [
    baseVar,
    baseVar.replace(/_API_KEY$/, ''),
    baseVar.replace(/_KEY$/, ''),
    baseVar.replace(/_TOKEN$/, ''),
    ...aliases,
    ...aliases.map((a) => a.replace(/_API_KEY$/, '')),
  ];

  const backupSuffixes = [
    '_BACKUP_KEYS',
    '_BACKUP_KEY',
    '_BACKUPS',
    '_BACKUP',
    '_KEYS',
  ];

  for (const prefix of prefixes) {
    for (const suffix of backupSuffixes) {
      const varName = `${prefix}${suffix}`;
      if (!primaryKeys.includes(varName)) {
        const val = process.env[varName];
        if (val) candidates.push(val);
      }
    }
    // Also check indexed slots: e.g. GMGN_KEY_1, GMGN_KEY_2, etc.
    for (let i = 1; i <= 10; i++) {
      const indexed = process.env[`${prefix}_${i}`] || process.env[`${prefix}_KEY_${i}`];
      if (indexed) candidates.push(indexed);
    }
  }

  return createApiKeyPool(baseVar, candidates);
}
