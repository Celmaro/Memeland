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
 * Pure graph primitives, no IO in the core methods (fully unit-testable); an
 * optional injected GraphIO gives durability (P9) without coupling the logic.
 */

import fs from 'fs';
import path from 'path';

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
  /** P9 — identity-edge provenance: `${a}|${b}` (sorted lowercase) → why the edge exists. */
  private edgeProvenance = new Map<string, string>();

  constructor(private readonly io?: GraphIO) {}

  /** Canonical key for an undirected identity edge (sorted lowercase). */
  private edgeKey(a: string, b: string): string {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
    return `${x}|${y}`;
  }

  /** Add a wallet node (idempotent). */
  public addNode(wallet: string, meta: WalletMeta = {}): void {
    const w = wallet.toLowerCase();
    if (!this.meta.has(w)) this.meta.set(w, meta);
    else Object.assign(this.meta.get(w)!, meta);
    if (!this.adj.has(w)) this.adj.set(w, new Set());
  }

  /** Add an undirected edge between two wallets (idempotent). P9 records provenance. */
  public addEdge(a: string, b: string, provenance?: string): void {
    this.applyEdge(a, b, provenance);
    this.io?.append({ type: 'edge', a, b, provenance });
  }

  /** Mutation only (no io append) — shared by addEdge and hydration replay. */
  private applyEdge(a: string, b: string, provenance?: string): void {
    const wa = a.toLowerCase();
    const wb = b.toLowerCase();
    if (wa === wb) return;
    this.addNode(wa);
    this.addNode(wb);
    this.adj.get(wa)!.add(wb);
    this.adj.get(wb)!.add(wa);
    if (provenance) this.edgeProvenance.set(this.edgeKey(a, b), provenance);
  }

  /** P9 — why a pair of wallets are linked (e.g. `handle:<h>`, `co-trade`, `identity-resolve`). */
  public provenanceFor(a: string, b: string): string | undefined {
    return this.edgeProvenance.get(this.edgeKey(a, b));
  }

  /** Connect a handle's resolved wallets together (same entity). */
  public linkHandleWallets(sol?: string, evm?: string): void {
    if (sol && evm) this.addEdge(sol, evm, 'identity-resolve');
  }

  /**
   * Phase 4 — register a handle→wallet identity observation (provider + chain
   * attributed). Links all of the handle's wallets into one cluster (each edge
   * carries `handle:<h>` provenance) and records the reverse mappings so a wallet
   * resolves back to its handles. Persisted as one `handle` event.
   */
  public registerHandle(handle: string, opts: { chain?: string; provider?: string; wallets: string[] }): void {
    this.applyHandle(handle, opts);
    this.io?.append({ type: 'handle', handle, chain: opts.chain, provider: opts.provider, wallets: opts.wallets ?? [] });
  }

  /** Mutation only (no io append) — shared by registerHandle and hydration replay. */
  private applyHandle(handle: string, opts: { chain?: string; provider?: string; wallets: string[] }): void {
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
      for (let j = i + 1; j < arr.length; j++) this.applyEdge(arr[i]!, arr[j]!, `handle:${h}`);
    }
    for (const w of raw) {
      this.addNode(w, { handle, chain: opts.chain, provider: opts.provider });
      if (!this.walletToHandles.has(w)) this.walletToHandles.set(w, new Set());
      this.walletToHandles.get(w)!.add(h);
    }
  }

  /**
   * P9 — rebuild the identity graph from a durable event history after a restart.
   * Replays edge (with provenance) and handle-identity events. Applies only when
   * the graph is empty this process, so it never clobbers live divergence.
   */
  public hydrate(events: GraphEvent[]): void {
    if (this.adj.size > 0 || this.meta.size > 0) return;
    for (const ev of events) {
      if (ev.type === 'handle') this.applyHandle(ev.handle, { chain: ev.chain, provider: ev.provider, wallets: ev.wallets ?? [] });
      else if (ev.type === 'edge') this.applyEdge(ev.a, ev.b, ev.provenance);
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

/* ------------------------------------------------------------------ *
 * P9 — identity-edge durability + provenance.                         *
 * The on-chain identity graph was process-local, so the wallet→handle→ * co-trade
 * cluster the anti-double-count moat depends on vanished on restart.   *
 * Mirror the P7/P8 pattern: durable event log + restart hydration.     *
 * ------------------------------------------------------------------ */

/** A durable identity-graph mutation: an edge (with provenance) or a handle→wallets observation. */
export type GraphEvent =
  | { type: 'edge'; a: string; b: string; provenance?: string }
  | { type: 'handle'; handle: string; chain?: string; provider?: string; wallets: string[] };

/** Durable sink for identity-graph mutations. */
export interface GraphIO {
  append(ev: GraphEvent): void;
}

export const DEFAULT_IDENTITY_GRAPH_FILE = path.resolve('database', 'identity-graph.jsonl');

/** Resolve the Postgres connection string for the durable identity graph. */
function graphPostgresUrl(): string | null {
  return process.env.DATABASE_URL ?? process.env.POSTGRES_URI ?? process.env.POSTGRES_CONNECTION_STRING ?? null;
}

/** File-backed GraphIO — one JSON line per identity-graph event (JSONL). */
export function fileGraphIO(filePath: string = DEFAULT_IDENTITY_GRAPH_FILE): GraphIO {
  return {
    append: (ev: GraphEvent) => {
      try {
        const absolutePath = path.resolve(filePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.appendFileSync(absolutePath, `${JSON.stringify(ev)}\n`, 'utf-8');
      } catch (error) {
        console.warn(`[GRAPH] failed to append ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/** Postgres-backed GraphIO — appends each identity-graph event as a JSONB row. Fail-open, lazy pool. */
export function pgGraphIO(url: string = graphPostgresUrl() ?? ''): GraphIO {
  const dbUrl = url || null;
  let pool: any = null;
  let ready = false;
  const ensurePool = async (): Promise<any> => {
    if (!dbUrl) return null;
    if (!pool) {
      const { default: Pg } = await import('pg');
      pool = new Pg.Pool({ connectionString: dbUrl, max: 2 });
    }
    if (!ready) {
      try { await pool.query('SELECT 1'); ready = true; } catch { /* retry on next append */ }
    }
    return ready ? pool : null;
  };
  return {
    append: (ev: GraphEvent) => {
      if (!dbUrl) return;
      void ensurePool()
        .then((p) => p?.query('INSERT INTO graph_events (payload, created_at) VALUES ($1, $2)', [JSON.stringify(ev), Date.now()]))
        .catch(() => { /* fail-open */ });
    },
  };
}

/** Load durable identity-graph events as GraphEvent[]. Postgres when a URL is present, else JSONL. */
export async function loadGraphEvents(opts?: { url?: string; file?: string }): Promise<GraphEvent[]> {
  const url = opts?.url ?? graphPostgresUrl();
  const events: GraphEvent[] = [];
  if (url) {
    try {
      const { default: Pg } = await import('pg');
      const pool = new Pg.Pool({ connectionString: url, max: 2 });
      const { rows } = await pool.query<{ payload: string }>('SELECT payload FROM graph_events');
      await pool.end();
      for (const r of rows) {
        try { events.push(JSON.parse(r.payload) as GraphEvent); } catch { /* skip bad row */ }
      }
      return events;
    } catch (err) {
      console.warn(`[GRAPH] failed to load durable events: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  const filePath = path.resolve(opts?.file ?? DEFAULT_IDENTITY_GRAPH_FILE);
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line) as GraphEvent); } catch { /* skip bad line */ }
    }
  } catch { /* no file yet */ }
  return events;
}

/** Create the default identity graph: Postgres-backed (with hydration) when a DB URL is present, else file-backed. */
export function createDefaultWalletGraph(): WalletGraph {
  const url = graphPostgresUrl();
  const g = new WalletGraph(url ? pgGraphIO(url) : fileGraphIO());
  if (url) {
    void loadGraphEvents({ url })
      .then((evs) => { if (evs.length > 0) g.hydrate(evs); })
      .catch(() => { /* hydration is best-effort */ });
  }
  return g;
}

/** Process-wide wallet graph for the screening cycle (durable when DB/Postgres URL is set). */
export const globalWalletGraph = createDefaultWalletGraph();