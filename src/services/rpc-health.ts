/**
 * T1 — RPC health monitor + automatic penalty boxing (lag quarantine).
 *
 * Complements the existing `RPCFailoverManager` (which handles per-chain pools,
 * chainId verification, latency probing, 429 circuits and request-level retry).
 * This module adds the two capabilities the manager does NOT have:
 *
 *  - **Block-lag quarantine**: after a deep micro-reorg a node can serve stale
 *    blocks. `verifyBlockLag` cross-checks the latest block number across two
 *    independent RPCs and quarantines any host lagging by more than `threshold`
 *    blocks — so a lagging node is dropped rather than selected.
 *  - **Exponential-backoff penalty boxing**: `RpcHealthMonitor.markFailure`
 *    quarantines a host with exponential backoff (capped), `markSuccess` decays
 *    its failure count, and `getActiveEndpoint` returns the healthiest
 *    non-quarantined host. `withLagQuarantine` wraps an existing host selector
 *    (e.g. the failover manager's `getActiveRPC`) to skip quarantined hosts
 *    fail-open.
 *
 * Fail-open contract: no node list → the wrapped selector is passed through
 * untouched; a monitor with no quarantines behaves identically to the selector
 * it wraps. It never throws into the caller.
 */

export interface ManagedRpcNode {
  url: string;
  laggingBlocks: number;
  quarantinedUntil: number;
  failureCount: number;
}

/** Cross-RPC block-lag threshold (blocks). 3 per the operational spec. */
export const DEFAULT_LAG_THRESHOLD_BLOCKS = 3;
/** Backoff cap (ms) — 60s. */
const BACKOFF_CAP_MS = 60_000;

export class RpcHealthMonitor {
  private nodes: ManagedRpcNode[] = [];
  private readonly now: () => number;

  constructor(urls: string[], now?: () => number) {
    this.now = now ?? (() => Date.now());
    this.nodes = urls.map((url) => ({
      url,
      laggingBlocks: 0,
      quarantinedUntil: 0,
      failureCount: 0,
    }));
  }

  /** The healthiest non-quarantined host (lowest failureCount, first wins). */
  public getActiveEndpoint(): string {
    const now = this.now();
    const healthy = this.nodes.filter((n) => n.quarantinedUntil <= now);
    if (healthy.length === 0) {
      // Emergency: reset all quarantines to prevent a complete system halt.
      this.nodes.forEach((n) => {
        n.quarantinedUntil = 0;
      });
      return this.nodes[0]?.url ?? '';
    }
    healthy.sort((a, b) => a.failureCount - b.failureCount);
    return healthy[0]!.url;
  }

  public markFailure(url: string): void {
    const node = this.nodes.find((n) => n.url === url);
    if (!node) return;
    node.failureCount += 1;
    const backoffMs = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** node.failureCount);
    node.quarantinedUntil = this.now() + backoffMs;
  }

  public markSuccess(url: string): void {
    const node = this.nodes.find((n) => n.url === url);
    if (!node) return;
    node.failureCount = Math.max(0, node.failureCount - 1);
  }

  /** Mark a specific node as lagging by N blocks (quarantine if over threshold). */
  public recordLag(url: string, laggingBlocks: number, threshold: number = DEFAULT_LAG_THRESHOLD_BLOCKS): void {
    const node = this.nodes.find((n) => n.url === url);
    if (!node) return;
    node.laggingBlocks = laggingBlocks;
    if (laggingBlocks > threshold) {
      node.quarantinedUntil = this.now() + Math.min(BACKOFF_CAP_MS, 1000 * 2 ** (node.failureCount + 1));
    }
  }

  public status(): ManagedRpcNode[] {
    return this.nodes.map((n) => ({ ...n }));
  }
}

export interface BlockHeightFetcher {
  (url: string): Promise<number>;
}

/**
 * Cross-verify the latest block number across a set of RPCs and quarantine any
 * host that lags the freshest observed height by more than `threshold` blocks.
 * A host whose height is ahead of the rest (fresh micro-reorg observer) is NOT
 * penalized — lag relative to the observed max is what matters. Fail-open: a
 * host that fails to answer is reported (via `reportFailure`) but never throws
 * the whole call.
 */
export async function verifyBlockLag(
  urls: string[],
  fetchHeight: BlockHeightFetcher,
  monitor: RpcHealthMonitor,
  opts: { threshold?: number; reportFailure?: (url: string) => void } = {},
): Promise<Record<string, number>> {
  const threshold = opts.threshold ?? DEFAULT_LAG_THRESHOLD_BLOCKS;
  const report = opts.reportFailure ?? ((url: string) => monitor.markFailure(url));
  const heights = new Map<string, number>();
  await Promise.all(
    urls.map(async (url) => {
      try {
        const h = await fetchHeight(url);
        heights.set(url, h);
        monitor.markSuccess(url);
      } catch {
        report(url);
      }
    }),
  );
  const observed = [...heights.values()];
  if (observed.length === 0) return Object.fromEntries(heights);
  const maxHeight = Math.max(...observed);
  for (const [url, h] of heights.entries()) {
    monitor.recordLag(url, maxHeight - h, threshold);
  }
  return Object.fromEntries(heights);
}

/**
 * Wrap an existing host selector so it skips quarantined hosts. Fail-open: an
 * empty node list or a selector returning '' passes straight through.
 */
export function withLagQuarantine(
  monitor: RpcHealthMonitor,
  select: (chain: string) => string,
  now?: () => number,
): (chain: string) => string {
  return (chain: string) => {
    const chosen = select(chain);
    if (!chosen) return '';
    const node = monitor
      .status()
      .find((n) => n.url === chosen && (n.quarantinedUntil ?? 0) <= (now?.() ?? Date.now()));
    return node ? chosen : '';
  };
}
