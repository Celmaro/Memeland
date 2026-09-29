/**
 * P0.4 — WalletGraph (provider-architecture v2: durable on-chain moat).
 *
 * A lightweight in-memory wallet graph seeded from the trader-intelligence
 * layer (FOMO identity-resolve / leaderboard wallet ids) and co-trade evidence.
 * The moat is that third parties
 * (FOMO, GMGN) only expose *their* curated wallets — the graph we build from
 * transport data is ours. Used to:
 *   - find wallets co-active on the same persistent trader list (clusters)
 *   - resolve a handle → wallets → neighbours for copy-trading signals
 *
 * Pure graph primitives, no IO, fully unit-testable.
 */

export interface WalletMeta {
  handle?: string;
  chain?: string;
  provider?: string;
  [k: string]: unknown;
}

/**
 * Phase 4 — resolved trader identity. A single physical trader may surface
 * under different provider handles and different per-chain wallets. Resolving
 * collapses handle(s) + wallet(s) + provider identity into one canonical actor.
 */
export interface TraderIdentity {
  /** Deterministic stable id — first known handle, else lowest wallet. */
  canonicalId: string;
  /** The handle that matched the query, when the query was a known handle. */
  handle?: string;
  /** Every handle observed for this identity (across providers). */
  handles: string[];
  /** Every wallet in this identity's connected cluster (sol+evm, same handle). */
  wallets: string[];
  /** Distinct chains the identity's wallets appear on. */
  chains: string[];
  /** Distinct leaderboard providers that surfaced this identity. */
  providers: string[];
}

/** A connected component of wallets treated as ONE economic actor (cohort). */
export interface WalletCohort {
  wallets: string[];
  handles: string[];
  chains: string[];
  providers: string[];
}

export class WalletGraph {
  private adj = new Map<string, Set<string>>();
  private meta = new Map<string, WalletMeta>();
  /** handle (lowercase) → Set<wallet>. */
  private handleToWallets = new Map<string, Set<string>>();
  /** wallet (lowercase) → Set<handle>. */
  private walletToHandles = new Map<string, Set<string>>();

  /** Add a wallet node (idempotent). */
  public addNode(wallet: string, meta: WalletMeta = {}): void {
    const w = wallet.toLowerCase();
    if (!this.meta.has(w)) this.meta.set(w, meta);
    else Object.assign(this.meta.get(w)!, meta);
    if (!this.adj.has(w)) this.adj.set(w, new Set());
  }

  /** Add an undirected edge between two wallets (idempotent). */
  public addEdge(a: string, b: string): void {
    const wa = a.toLowerCase();
    const wb = b.toLowerCase();
    if (wa === wb) return;
    this.addNode(wa);
    this.addNode(wb);
    this.adj.get(wa)!.add(wb);
    this.adj.get(wb)!.add(wa);
  }

  /** Connect a handle's resolved wallets together (same entity). */
  public linkHandleWallets(sol?: string, evm?: string): void {
    if (sol && evm) this.addEdge(sol, evm);
  }

  /**
   * Phase 4 — register a handle→wallet identity observation (provider +
   * chain attributed). Links all of the handle's wallets into one cluster and
   * records the reverse mappings so a wallet resolves back to its handles.
   */
  public registerHandle(handle: string, opts: { chain?: string; provider?: string; wallets: string[] }): void {
    const h = handle.toLowerCase();
    const raw = (opts.wallets ?? []).map((w) => w.toLowerCase()).filter(Boolean);
    if (raw.length === 0) return;
    // Union across repeated observations of the same handle.
    let wset = this.handleToWallets.get(h) ?? new Set<string>();
    for (const w of raw) wset.add(w);
    this.handleToWallets.set(h, wset);
    // Link every pair so all of this handle's wallets are one entity.
    const arr = [...wset];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) this.addEdge(arr[i]!, arr[j]!);
    }
    for (const w of raw) {
      this.addNode(w, { handle, chain: opts.chain, provider: opts.provider });
      if (!this.walletToHandles.has(w)) this.walletToHandles.set(w, new Set());
      this.walletToHandles.get(w)!.add(h);
    }
  }

  /** Wallets associated with a handle. */
  public walletsOfHandle(handle: string): string[] {
    return [...(this.handleToWallets.get(handle.toLowerCase()) ?? [])];
  }

  /** Handles associated with a wallet. */
  public handlesOfWallet(wallet: string): string[] {
    return [...(this.walletToHandles.get(wallet.toLowerCase()) ?? [])];
  }

  public neighbours(wallet: string): string[] {
    return [...(this.adj.get(wallet.toLowerCase()) ?? [])];
  }

  public metaOf(wallet: string): WalletMeta | undefined {
    return this.meta.get(wallet.toLowerCase());
  }

  /**
   * Phase 4 — resolve an identity (handle OR wallet) to a canonical trader:
   * gather its wallets, expand to the full connected cluster, then collect
   * every handle / chain / provider attached to that cluster.
   */
  public resolveTrader(identity: string): TraderIdentity | undefined {
    const id = identity.toLowerCase();
    const seed = new Set<string>();
    const hw = this.handleToWallets.get(id);
    if (hw) {
      for (const w of hw) seed.add(w);
    } else if (this.adj.has(id)) {
      seed.add(id);
    }
    // Expand each seed to its connected cluster (same physical actor).
    const expanded = new Set<string>();
    for (const w of seed) {
      for (const n of this.connectedCluster(w)) expanded.add(n);
    }
    if (expanded.size === 0) return undefined;
    const wallets = [...expanded];
    const handles = new Set<string>();
    const chains = new Set<string>();
    const providers = new Set<string>();
    for (const w of wallets) {
      const hs = this.walletToHandles.get(w);
      if (hs) for (const h of hs) handles.add(h);
      const m = this.meta.get(w);
      if (m?.chain) chains.add(m.chain);
      if (m?.provider) providers.add(m.provider);
    }
    const handleArr = [...handles];
    const canonicalId = handleArr[0] ?? wallets[0]!;
    return {
      canonicalId,
      handle: handleArr.includes(id) ? id : handleArr[0],
      handles: handleArr,
      wallets,
      chains: [...chains],
      providers: [...providers],
    };
  }

  /**
   * Phase 4 — wallet-native cohorts: every connected component is ONE
   * economic actor, regardless of which provider's handle surfaced it. Handles
   * sharing a wallet cluster collapse into a single cohort.
   */
  public walletCohorts(): WalletCohort[] {
    const seen = new Set<string>();
    const cohorts: WalletCohort[] = [];
    for (const w of this.adj.keys()) {
      if (seen.has(w)) continue;
      const cluster = this.connectedCluster(w);
      for (const n of cluster) seen.add(n);
      const handles = new Set<string>();
      const chains = new Set<string>();
      const providers = new Set<string>();
      for (const n of cluster) {
        const hs = this.walletToHandles.get(n);
        if (hs) for (const h of hs) handles.add(h);
        const m = this.meta.get(n);
        if (m?.chain) chains.add(m.chain);
        if (m?.provider) providers.add(m.provider);
      }
      cohorts.push({ wallets: cluster, handles: [...handles], chains: [...chains], providers: [...providers] });
    }
    return cohorts;
  }

  /** BFS cluster reachable from a wallet (the trader's co-active cohort). */
  public connectedCluster(wallet: string): string[] {
    const w = wallet.toLowerCase();
    const seen = new Set<string>();
    if (!this.adj.has(w)) return [];
    const queue = [w];
    seen.add(w);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const n of this.adj.get(cur) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return [...seen];
  }

  public size(): number {
    return this.adj.size;
  }
}

/** Process-wide wallet graph for the screening cycle. */
export const globalWalletGraph = new WalletGraph();