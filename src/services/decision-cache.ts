/**
 * PR 5 / Kernel F — Decision Cache (A16 azimuth sticky conviction + A24 Million
 * immutable one-way-door / owner dedup + GARCH walk-forward vol-target cache).
 *
 * ADOPTIVE: a new module with no existing signature changes (G1). The cache is
 * intentionally small and injection-friendly: owner resolution and GARCH vol
 * fetching are constructor seams so the module stays pure/testable.
 */

export type Address = string;

export const DEFAULT_STICKY_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_VOL_TARGET_TTL_MS = 21 * 24 * 60 * 60 * 1000;

export interface StickyCacheOptions {
  /** Re-evaluate when the supplied/observed price has moved this much (percent). */
  priceMovePct?: number;
  /** Short TTL for sticky decisions. Defaults to 5 minutes. */
  ttlMs?: number;
  /** Optional current price for this key when no constructor getPrice is configured. */
  price?: number;
}

export interface DecisionCacheOptions {
  now?: () => number;
  /** Optional price reader used by getSticky when the caller does not pass opts.price. */
  getPrice?: (key: string) => number;
  /** Maps a wallet to its controlling owner id. */
  resolveOwner?: (wallet: Address) => Promise<Address | null> | Address | null;
  /** Fetches a fresh GARCH vol target for a token. */
  fetchVolTarget?: (token: Address) => Promise<number | null> | number | null;
}

interface CacheEntry<T> {
  value: T;
  at: number;
  price?: number;
}

export class DecisionCache {
  private readonly now: () => number;
  private readonly sticky = new Map<string, CacheEntry<unknown>>();
  private readonly immutable = new Map<string, CacheEntry<unknown>>();
  private readonly ownerCache = new Map<string, Address>();
  private readonly volTargets = new Map<string, CacheEntry<number>>();
  private readonly getPrice?: (key: string) => number;
  private readonly resolveOwner?: (wallet: Address) => Promise<Address | null> | Address | null;
  private readonly fetchVolTarget?: (token: Address) => Promise<number | null> | number | null;

  constructor(opts: DecisionCacheOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.getPrice = opts.getPrice;
    this.resolveOwner = opts.resolveOwner;
    this.fetchVolTarget = opts.fetchVolTarget;
  }

  /** Short-TTL sticky cache; re-evaluates when TTL elapses or price moves too far. */
  async getSticky<T>(key: string, validator: () => T, opts: StickyCacheOptions = {}): Promise<T | null> {
    const ttlMs = opts.ttlMs ?? DEFAULT_STICKY_TTL_MS;
    const price = opts.price !== undefined ? opts.price : this.getPrice?.(key);
    const hit = this.sticky.get(key) as CacheEntry<T> | undefined;

    if (hit) {
      const withinTtl = this.now() - hit.at <= ttlMs;
      let withinMove = true;
      if (opts.priceMovePct !== undefined && price !== undefined) {
        if (hit.price === undefined) {
          withinMove = false;
        } else {
          const base = Math.max(Math.abs(hit.price), 1e-12);
          const movePct = (Math.abs(price - hit.price) / base) * 100;
          withinMove = movePct <= Math.abs(opts.priceMovePct);
        }
      }
      if (withinTtl && withinMove) return hit.value;
    }

    try {
      const value = validator();
      if (value === null || value === undefined) return null;
      this.sticky.set(key, { value, at: this.now(), ...(price !== undefined ? { price } : {}) });
      return value;
    } catch {
      return null;
    }
  }

  /**
   * Million one-way door: the first successfully resolved immutable fact is kept
   * forever. Once set, later validators cannot change it, even after the long TTL.
   */
  async getImmutable<T>(key: string, validator: () => Promise<T>, _ttlMs: number): Promise<T | null> {
    const hit = this.immutable.get(key) as CacheEntry<T> | undefined;
    if (hit) return hit.value;

    try {
      const value = await validator();
      if (value === null || value === undefined) return null;
      this.immutable.set(key, { value, at: this.now() });
      return value;
    } catch {
      return null;
    }
  }

  /** Million owner-id dedup: returns one owner confirmation per controlling actor. */
  async dedupByOwner(wallets: Address[]): Promise<Address[]> {
    const owners: Address[] = [];
    const seen = new Set<string>();

    for (const wallet of wallets) {
      const walletKey = this.normalize(wallet);
      let owner = this.ownerCache.get(walletKey);
      if (owner === undefined) {
        try {
          const resolved = this.resolveOwner ? await this.resolveOwner(wallet) : null;
          owner = resolved ?? wallet;
        } catch {
          owner = wallet;
        }
        this.ownerCache.set(walletKey, owner);
      }

      const ownerKey = this.normalize(owner);
      if (!seen.has(ownerKey)) {
        seen.add(ownerKey);
        owners.push(owner);
      }
    }

    return owners;
  }

  /** GARCH walk-forward vol-target cache with a 3-week refit window. */
  async getVolTarget(token: Address): Promise<number | null> {
    const key = this.normalize(token);
    const hit = this.volTargets.get(key);
    if (hit && this.now() - hit.at <= DEFAULT_VOL_TARGET_TTL_MS) return hit.value;
    if (!this.fetchVolTarget) return null;

    try {
      const value = await this.fetchVolTarget(token);
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      this.volTargets.set(key, { value, at: this.now() });
      return value;
    } catch {
      return null;
    }
  }

  private normalize(value: string): string {
    return value.toLowerCase();
  }
}

/**
 * Kernel F global decision cache (W-03 wiring). No constructor seams are wired
 * (getPrice / resolveOwner / fetchVolTarget are absent) so the cache is
 * intentionally inert: getSticky/getImmutable/dedupByOwner all behave
 * pass-through / fail-closed, which keeps the live path neutral unless a caller
 * later injects real resolution. The one shared instance lets the screening
 * agent and consensus read the same sticky/immutable facts within a process.
 */
export const globalDecisionCache = new DecisionCache();
