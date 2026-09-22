/**
 * KC1 / Kernel L — generic TTL cache (replaces 8 ad-hoc TTL-cached Map patterns
 * across adapters and services).
 *
 * Auto-evicts entries on read past TTL; supports an optional LRU cap to
 * bound memory under bursty keys (e.g. untrusted symbol addresses). Pure
 * utility, no I/O, no env reads — caller controls the clock and TTL.
 */

export interface TtlCacheOptions<V> {
  /** Time-to-live in milliseconds. Required — fail fast on misconfiguration. */
  ttlMs: number;
  /** Optional LRU cap. When set, the oldest inserted entry is dropped first. */
  maxEntries?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  /** Insertion / last-touch timestamp (ms). */
  at: number;
}

export class TtlCache<V> {
  private readonly ttlMs: number;
  private readonly maxEntries?: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry<V>>();

  constructor(opts: TtlCacheOptions<V>) {
    if (!(opts.ttlMs > 0)) throw new Error('TtlCache: ttlMs must be > 0');
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries;
    this.now = opts.now ?? Date.now;
  }

  /** Number of live entries (excludes stale ones until a get() evicts them). */
  public size(): number {
    return this.entries.size;
  }

  /** Returns the value if present and fresh; otherwise null (and evicts). */
  public get(key: string): V | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  /** True if a fresh value is present. */
  public has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** Insert or replace. Refreshes the entry timestamp; honors maxEntries LRU. */
  public set(key: string, value: V): void {
    this.entries.set(key, { value, at: this.now() });
    this.evictIfFull();
  }

  /** Drop a key (no-op if absent). */
  public delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Drop all entries. */
  public clear(): void {
    this.entries.clear();
  }

  /** Drop expired entries without reading them. Returns number evicted. */
  public prune(): number {
    const now = this.now();
    let n = 0;
    for (const [k, e] of this.entries) {
      if (now - e.at > this.ttlMs) {
        this.entries.delete(k);
        n += 1;
      }
    }
    return n;
  }

  private evictIfFull(): void {
    if (!this.maxEntries) return;
    while (this.entries.size > this.maxEntries) {
      // Map iteration order is insertion order; the first key is the oldest.
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}