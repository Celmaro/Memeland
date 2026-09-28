/**
 * P0.4 — WalletGraph (provider-architecture v2: durable on-chain moat).
 *
 * A lightweight in-memory wallet graph seeded from the trader-intelligence
 * layer (FOMO identity-resolve / leaderboard wallet ids + Helius
 * getAssetsByOwner) and co-trade evidence. The moat is that third parties
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
  [k: string]: unknown;
}

export class WalletGraph {
  private adj = new Map<string, Set<string>>();
  private meta = new Map<string, WalletMeta>();

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

  public neighbours(wallet: string): string[] {
    return [...(this.adj.get(wallet.toLowerCase()) ?? [])];
  }

  public metaOf(wallet: string): WalletMeta | undefined {
    return this.meta.get(wallet.toLowerCase());
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