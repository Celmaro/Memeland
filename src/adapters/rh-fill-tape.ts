/**
 * Q04 - Robinhood-Chain (4663) fill-tape reader + wallet resolution
 * (SRC-070/076/117 chain tape; SRC-072 batch holdings + cache/in-flight dedupe).
 * An INDEPENDENT confirmation signal over local RPC that mirrors what GMGN
 * reports for track-trades. It never replaces GMGN; it corroborates. A tape
 * gap degrades to `failOpen` (unknown), never a false confirmation.
  */

 import { TtlCache } from '../cache/ttl-cache.js';

 export interface RpcBalanceEntry {
  address: string;
  balance: number;
}

export interface RpcBalanceProvider {
  /** Batch-read balances for a set of addresses on a chain. */
  getBalances(addresses: string[], chainId: number): Promise<RpcBalanceEntry[]>;
}

export interface RawFillRow {
  wallet: string;
  side: 'buy' | 'sell';
  amountUsd: number;
  timestamp: number;
}

export interface FillTapeEntry extends RawFillRow {
  chainId: number;
  tokenAddress: string;
  label?: string;
}

export interface FillTapeWindow {
  chainId: number;
  tokenAddress: string;
  /** Ordered descending by timestamp, capped at `maxWindow`. */
  entries: FillTapeEntry[];
  /** True when the read was capped at `maxWindow` (more fills available). */
  truncated: boolean;
  /** True when a gap/eror prevented a confident read — treat as unknown. */
  failOpen: boolean;
}

export interface RhFillTapeOptions {
  chainId?: number;
  /** Max fills returned per window. Default 200. */
  maxWindow?: number;
  /** Wallet-label cache TTL in ms. Default 10 min. */
  ttlMs?: number;
  /** Static address→label mappings applied before/behind any RPC lookup. */
  labelHints?: Record<string, string>;
}

interface Labeled {
  label?: string;
}

export class RhFillTapeReader {
  private readonly chainId: number;
  private readonly maxWindow: number;
  private labelHints: Map<string, string>;
  private readonly labelCache = new TtlCache<{ label: string }>({ ttlMs: 600_000 });
  private inFlight = new Map<string, Promise<Labeled>>();

    constructor(
  private readonly rpc: RpcBalanceProvider,
  private readonly fetchRawFills: (tokenAddress: string, chainId: number) => Promise<RawFillRow[]>,
    opts: RhFillTapeOptions = {}
    ) {
    this.chainId = opts.chainId ?? 4663;
    this.maxWindow = opts.maxWindow ?? 200;
    this.labelHints = new Map(Object.entries(opts.labelHints ?? {}));
    }

  /**
   * Return a bounded, chain/address-scoped fill window, ordered newest-first.
   * Fail-open: malformed rows or missing rows degrade to `failOpen:true`.
   */
  async readFillTape(tokenAddress: string, chainId = this.chainId): Promise<FillTapeWindow> {
    if (String(chainId) !== String(this.chainId)) {
    return { chainId, tokenAddress, entries: [], truncated: false, failOpen: true };
    }
    let rows: RawFillRow[];
    try {
    rows = await this.fetchRawFills(tokenAddress, chainId);
    } catch {
    return { chainId, tokenAddress, entries: [], truncated: false, failOpen: true };
    }
    if (!Array.isArray(rows) || rows.length === 0) {
    return { chainId, tokenAddress, entries: [], truncated: false, failOpen: false };
    }

    const failOpen = rows.some((r) => !r.wallet || !Number.isFinite(r.amountUsd) || r.amountUsd <= 0 || !Number.isFinite(r.timestamp));
    const okRows = rows
    .filter((r) => r.wallet && Number.isFinite(r.amountUsd) && r.amountUsd > 0 && Number.isFinite(r.timestamp))
    .map((r) => ({ ...r }));

    // Resolve labels in parallel batches (shared in-flight/cache dedupe).
    const labeled = await this.resolveLabels(okRows.map((r) => r.wallet));
    const entries: FillTapeEntry[] = okRows.map((r) => ({
    ...r,
    chainId,
    tokenAddress,
    label: labeled.get(r.wallet)?.label,
    }));
    entries.sort((a, b) => b.timestamp - a.timestamp);
    const truncated = entries.length > this.maxWindow;
    return {
    chainId,
    tokenAddress,
    entries: entries.slice(0, this.maxWindow),
    truncated,
    failOpen,
    };
  }

  /**
   * Resolve a list of addresses to labels. Concurrent lookups for the same
   * address are deduped to a single in-flight promise; results are cached.
   */
  private async resolveLabels(addresses: string[]): Promise<Map<string, Labeled>> {
      const out = new Map<string, Labeled>();
    const unique = [...new Set(addresses)];
    const toFetch = unique.filter((a) => {
    const hit = this.labelCache.get(a);
    if (hit) {
      out.set(a, { label: hit.label });
      return false;
    }
    return true;
    });
    if (toFetch.length === 0) return out;

    // Batch by in-flight promise so concurrent resolveLabels calls share work.
    const fresh: string[] = [];
    await Promise.all(
    toFetch.map(async (address) => {
    const hinted = this.labelHints.get(address);
    if (hinted) {
      this.labelCache.set(address, { label: hinted });
      out.set(address, { label: hinted });
      return;
    }
    fresh.push(address);
    })
    );
    for (const address of fresh) {
    let p = this.inFlight.get(address);
    if (!p) {
    p = this.fetchLabel(address).finally(() => this.inFlight.delete(address));
    this.inFlight.set(address, p);
    }
    out.set(address, await p);
    }
    return out;
  }

  private async fetchLabel(address: string): Promise<Labeled> {
    try {
    const [row] = await this.rpc.getBalances([address], this.chainId);
    const label = row && row.balance > 0 ? this.labelHints.get(address) : undefined;
    this.labelCache.set(address, { label: label ?? `address:${address.slice(0, 6)}` });
    return { label };
    } catch {
    return { label: undefined };
    }
  }
}
