import { getEnvString } from '../config/config.js';
import { globalRateLimiter } from './provider-rate-limiter.js';
import { RpcHealthMonitor, verifyBlockLag, type BlockHeightFetcher } from './rpc-health.js';

export type RpcChainKey = 'rh' | 'eth' | 'bsc' | 'base' | 'sol';
export const RPC_CHAINS: RpcChainKey[] = ['rh', 'eth', 'bsc', 'base', 'sol'];

interface RpcStatus {
  url: string;
  latencyMs: number;
  healthy: boolean;
}

interface ChainRpcSpec {
  /** Env override var for this chain. */
  envVar: string;
  /** Verified free defaults (probed live from this network 2026-09-23). */
  defaults: string[];
  /** Chain ID expected from eth_chainId (EVM) or null for sol (getVersion). */
  chainId?: string;
}

/**
 * Verified hosts (all probed live via eth_chainId / getVersion on 2026-09-23):
 * - robinhood: official + publicnode + drpc all OK (0x1237)
 * - eth: publicnode + drpc + nownodes all OK (0x1)
 * - bsc: publicnode + drpc + nownodes all OK (0x38); binance-dataseed TIMED OUT → not a default
 * - base: publicnode + drpc + official base.org all OK (0x2105)
 * - sol: publicnode + tatum + pocket + vibestation + leorpc + uniblock (verified 4.x) — official
 *         api.mainnet-beta/api.mainnet TIMED OUT, dRPC sol is paid-only → not defaults
 */
const CHAIN_RPC_SPEC: Record<RpcChainKey, ChainRpcSpec> = {
  rh: {
    envVar: 'EVM_ROBINHOOD_RPC_URL',
    defaults: [
      'https://rpc.mainnet.chain.robinhood.com',
      'https://robinhood-rpc.publicnode.com/',
      'https://robinhood.drpc.org/',
      'https://rpc-robinhood.blockmachine.io',
    ],
    chainId: '0x1237',
  },
  eth: {
    envVar: 'EVM_ETH_RPC_URL',
    defaults: [
      'https://ethereum-rpc.publicnode.com/',
      'https://eth.drpc.org/',
      'https://public-eth.nownodes.io/',
      'https://rpc-eth.blockmachine.io',
      'https://eth.api.pocket.network',
    ],
    chainId: '0x1',
  },
  bsc: {
    envVar: 'EVM_BSC_RPC_URL',
    defaults: [
      'https://bsc-rpc.publicnode.com/',
      'https://bsc.drpc.org/',
      'https://public-bsc.nownodes.io/',
      'https://rpc-bsc.blockmachine.io',
      'https://bsc.api.pocket.network',
    ],
    chainId: '0x38',
  },
  base: {
    envVar: 'EVM_BASE_RPC_URL',
    defaults: [
      'https://base-rpc.publicnode.com/',
      'https://base.drpc.org/',
      'https://mainnet.base.org/',
      'https://rpc-base.blockmachine.io',
      'https://base.api.pocket.network',
    ],
    chainId: '0x2105',
  },
  sol: {
    envVar: 'SOLANA_RPC_URL',
    // Verified live via getVersion 2026-09-23. publicnode + tatum + pocket +
    // vibestation + leorpc + uniblock all responded; api.mainnet.solana.com
    // timed out (same family as api.mainnet-beta), dRPC sol is paid-only.
    defaults: [
      'https://solana-rpc.publicnode.com/',
      'https://solana-mainnet.gateway.tatum.io/',
      'https://solana.api.pocket.network',
      'https://public.rpc.solanavibestation.com',
      'https://solana.leorpc.com/?api_key=FREE',
      'https://api.uniblock.dev/uni/v1/json-rpc?chainId=solana',
    ],
    chainId: undefined, // getVersion, no chain id check
  },
};

/** Map a legacy/deprecated bucket name onto the per-chain key it represents. */
function resolveChainKey(chain: string): RpcChainKey {
  const norm = (chain || '').toLowerCase();
  if (norm === 'evm') return 'rh'; // legacy single-EVM bucket was robinhood
  return (RPC_CHAINS as string[]).includes(norm) ? (norm as RpcChainKey) : 'rh';
}

export class RPCFailoverManager {
  private endpoints: Record<RpcChainKey, string[]>;
  private status: Record<RpcChainKey, RpcStatus[]>;
  private lastProbeAt = 0;
  /** URLs reported failed since the last probe (reportRPCFailure memory). */
  private failedUrls = new Set<string>();
  /** Per-chain block-lag quarantine monitors (T1, lag-based penalty boxing). */
  private lagMonitors: Partial<Record<RpcChainKey, RpcHealthMonitor>> = {};

  constructor() {
    const configured = (() => {
      const raw = getEnvString('RPC_FAILOVER_URLS');
      if (!raw) return {} as Record<string, string[]>;
      // base64: prefix → decode first. Lets operators ship the JSON through the
      // CLI `-k` flag (which cannot carry embedded quotes/commas) without a
      // comma/quote pitfall; plain JSON still works (used by .env / local runs).
      const jsonText = raw.startsWith('base64:')
        ? Buffer.from(raw.slice('base64:'.length), 'base64').toString('utf-8')
        : raw;
      try {
        const parsed = JSON.parse(jsonText) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        const out: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (Array.isArray(value)) {
            out[key.toLowerCase()] = value.filter((u): u is string => typeof u === 'string');
          }
        }
        return out;
      } catch {
        return {};
      }
    })();

    this.endpoints = {} as Record<RpcChainKey, string[]>;
    this.status = {} as Record<RpcChainKey, RpcStatus[]>;

    for (const chain of RPC_CHAINS) {
      const spec = CHAIN_RPC_SPEC[chain];
      const explicit = configured[chain] || [];
      const urls = [
        ...explicit,
        getEnvString(spec.envVar),
        ...spec.defaults,
      ].filter((u): u is string => Boolean(u));

      // dedupe preserving order
      this.endpoints[chain] = [...new Set(urls)];
      this.status[chain] = this.endpoints[chain].map((url) => ({ url, latencyMs: Infinity, healthy: false }));
    }
  }

  /** Env override only for a chain (bypasses defaults) — used by config/setup paths. */
  public getRpcUrls(chain: string): string[] {
    return this.endpoints[resolveChainKey(chain)];
  }

  public async probeLatencies(): Promise<void> {
    await Promise.all(
      RPC_CHAINS.flatMap((chain) =>
        this.status[chain].map(async (s) => {
          const start = Date.now();
          // I1-1: skip hosts whose circuit is open (429 storm paused them) —
          // they stay unhealthy WITHOUT a fresh request until backoff elapses.
          if (globalRateLimiter.isOpen(s.url)) {
            s.healthy = false;
            return;
          }
          try {
            const body = CHAIN_RPC_SPEC[chain].chainId
              ? '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
              : '{"jsonrpc":"2.0","method":"getVersion","params":[],"id":1}';
            const res = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
            if (res.status === 429) {
              // 429 → open this host's circuit (backoff), do NOT count against the
              // host as a permanent failure (provider outage ≠ dead endpoint).
              const retryAfter = res.headers.get('retry-after');
              globalRateLimiter.recordFailure(s.url, '429', retryAfter ? Number(retryAfter) * 1000 : undefined);
              s.latencyMs = Infinity;
              s.healthy = false;
              return;
            }
            globalRateLimiter.recordSuccess(s.url);
            // Even a 2xx can be a JSON-RPC error (e.g. "method unsupported" or a
            // host answering on a different chain's API); treat those as unhealthy.
            // EVM chains validate eth_chainId; SOL validates a real getVersion.
            let healthy = res.ok;
            if (healthy) {
              try {
                const json = (await res.json()) as { result?: unknown; error?: { code?: number } };
                const spec = CHAIN_RPC_SPEC[chain];
                if (spec.chainId) {
                  healthy = json.result === spec.chainId;
                } else if (chain === 'sol') {
                  const r = json.result as { 'solana-core'?: unknown } | null | undefined;
                  healthy = !!r && typeof r['solana-core'] === 'string' && (r['solana-core'] as string).length > 0;
                } else {
                  healthy = false; // unknown chain with no chainId spec → unusable
                }
              } catch {
                healthy = false;
              }
            }
            s.latencyMs = Date.now() - start;
            s.healthy = healthy;
          } catch {
            s.latencyMs = Infinity;
            s.healthy = false;
          }
        })
      )
    );
    // A successful probe pass resets the failed-host memory so a recovered
    // host can be selected again after the next probe.
    this.failedUrls.clear();
    this.lastProbeAt = Date.now();
  }

  public getActiveRPC(chain: string): string {
    const key = resolveChainKey(chain);
    const healthy = this.status[key]
      // R2: skip hosts whose 429 circuit is open (rate-limit backoff) so a
      // hammered host isn't selected between probes — not just at the next probe.
      // T1: also skip hosts quarantined for BLOCK-LAG (serving stale blocks).
      .filter((s) => s.healthy && !globalRateLimiter.isOpen(s.url) && !this.isLagQuarantined(key, s.url))
      .sort((a, b) => a.latencyMs - b.latencyMs);
    if (healthy[0]) return healthy[0].url;
    // No healthy host: prefer a default that has NOT been reported failed since
    // the last probe AND is not in rate-limit backoff, so reportRPCFailure →
    // retry actually moves to a different host instead of reselecting the one
    // just marked bad.
    const fallback = this.endpoints[key].find(
      (url) => !this.failedUrls.has(url) && !globalRateLimiter.isOpen(url),
    );
    return fallback ?? this.endpoints[key][0] ?? '';
  }

  /**
   * R3 — all currently-healthy hosts for a chain (fastest first), excluding
   * hosts whose 429 circuit is open. Lets multi-host consumers (e.g. EvmAdapter)
   * carry the whole pool so they rotate internally AND share the failover
   * manager's live health view instead of a divergent private list.
   */
  public getHealthyRPCs(chain: string): string[] {
    const key = resolveChainKey(chain);
    return this.status[key]
      .filter((s) => s.healthy && !globalRateLimiter.isOpen(s.url) && !this.isLagQuarantined(key, s.url))
      .sort((a, b) => a.latencyMs - b.latencyMs)
      .map((s) => s.url);
  }

  public getLastProbeAt(): number {
    return this.lastProbeAt;
  }

  public reportRPCFailure(chain: string, url: string): void {
    const key = resolveChainKey(chain);
    const entry = this.status[key].find((s) => s.url === url);
    if (entry) entry.healthy = false;
    this.failedUrls.add(url);
  }

  // ── T1 block-lag quarantine (fail-open complement to latency probing) ──────

  private lagMonitor(chain: RpcChainKey): RpcHealthMonitor {
    let m = this.lagMonitors[chain];
    if (!m) {
      m = new RpcHealthMonitor(this.endpoints[chain]);
      this.lagMonitors[chain] = m;
    }
    return m;
  }

  private isLagQuarantined(chain: RpcChainKey, url: string): boolean {
    const m = this.lagMonitors[chain];
    if (!m) return false;
    const node = m.status().find((n) => n.url === url);
    return node ? node.quarantinedUntil > Date.now() : false;
  }

  /** Record a measured block-lag for a host (quarantines when over threshold). */
  public recordBlockLag(chain: string, url: string, laggingBlocks: number): void {
    const key = resolveChainKey(chain);
    this.lagMonitor(key).recordLag(url, laggingBlocks);
  }

  /**
   * Cross-verify the latest block height across the chain's healthy hosts and
   * quarantine any that lag the observed max by more than the threshold. Uses a
   * chain-aware default block-number fetcher (eth_blockNumber / getSlot), or an
   * injected one. Fail-open: never throws; a batch error is logged and ignored.
   */
  public async runBlockLagVerification(chain: string, fetchHeight?: BlockHeightFetcher): Promise<void> {
    const key = resolveChainKey(chain);
    const urls = this.status[key].filter((s) => s.healthy).map((s) => s.url);
    if (urls.length < 2) return; // need ≥2 independent hosts to cross-verify
    const monitor = this.lagMonitor(key);
    const fetcher = fetchHeight ?? this.blockHeightFetcher(key);
    try {
      await verifyBlockLag(urls, fetcher, monitor, {
        reportFailure: (url) => this.reportRPCFailure(key, url),
      });
      const quarantined = monitor.status().filter((n) => n.quarantinedUntil > Date.now());
      if (quarantined.length > 0) {
        console.warn(`[RPC LAG] chain=${key} lag-quarantined: ${quarantined.map((n) => `${n.url}=lag${n.laggingBlocks}`).join(', ')}`);
      }
    } catch {
      // fail-open — a lag-check error never disrupts the pool
    }
  }

  private blockHeightFetcher(chain: RpcChainKey): BlockHeightFetcher {
    const isEvm = Boolean(CHAIN_RPC_SPEC[chain].chainId);
    const method = isEvm ? 'eth_blockNumber' : 'getSlot';
    return async (url: string): Promise<number> => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params: [], id: 1 }),
      });
      const json = (await res.json()) as { result?: unknown };
      const h = isEvm ? parseInt(json.result as string, 16) : (json.result as number);
      if (!Number.isFinite(h)) throw new Error('bad block height');
      return h;
    };
  }
}

export const globalRPCFailoverManager = new RPCFailoverManager();

/** R4 — hosts whose eth_chainId has already been verified this process. */
const chainIdVerifiedHosts = new Set<string>();

export interface FailoverCallOptions {
  /** Injectable fetcher (tests / alternate transport). Default: global fetch. */
  fetcher?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Pick<Response, 'ok' | 'json'>>;
  /** Injectable failure reporter. Default: globalRPCFailoverManager.reportRPCFailure. */
  report?: (chain: string, url: string) => void;
  /** Injectable host selector (tests / DI consumers). Default: the failover manager. */
  getActiveRPC?: (chain: string) => string;
  /**
   * R4 — optional expected eth_chainId. When set, the first call to a NEW host
   * is verified against it (cached per host), so a misrouted host that answers a
   * different chain is demoted and retried on a correct one.
   */
  expectedChainId?: string;
}

export interface FailoverCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * R1 — one failover-aware JSON-RPC POST against the per-chain pool. On failure
 * the host is demoted (reportRPCFailure) and the call retried once against the
 * next host, so a dead RPC rotates MID-CYCLE instead of waiting for the 5-min
 * probe. Optionally verifies eth_chainId (R4). Always fail-soft: returns
 * `{ ok:false, error }` (never throws) when both attempts fail or no host exists.
 */
export async function rpcCallWithFailover(
  chain: string,
  method: string,
  params: unknown[],
  opts: FailoverCallOptions = {},
): Promise<FailoverCallResult> {
  const key = resolveChainKey(chain);
  const report = opts.report ?? ((c, u) => globalRPCFailoverManager.reportRPCFailure(c, u));
  const getActive = opts.getActiveRPC ?? ((c: string) => globalRPCFailoverManager.getActiveRPC(c));
  const fetcher =
    opts.fetcher ??
    ((url: string, init: { method: string; headers: Record<string, string>; body: string }) =>
      (globalThis as { fetch: typeof fetch }).fetch(url, init));
  let lastErr: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const url = getActive(key);
    if (!url) break;
    // R4: verify chain id once per host (opt-in).
    if (opts.expectedChainId && !chainIdVerifiedHosts.has(url)) {
      try {
        const ci = await fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
        });
        if (!ci.ok) throw new Error('chainId http');
        const ciJson = (await ci.json()) as { result?: string };
        if (ciJson.result !== opts.expectedChainId) {
          throw new Error(`chainId mismatch (got ${ciJson.result}, want ${opts.expectedChainId})`);
        }
        chainIdVerifiedHosts.add(url);
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        report(key, url);
        continue;
      }
    }
    try {
      const res = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      });
      if (!res.ok) throw new Error('HTTP error');
      const data = (await res.json()) as { result?: unknown; error?: { message?: string } | string };
      if (data.error) {
        const m = typeof data.error === 'string' ? data.error : data.error?.message;
        throw new Error(m ?? 'json-rpc error');
      }
      return { ok: true, result: data.result };
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      report(key, url);
    }
  }
  return { ok: false, error: lastErr ?? 'no active RPC host' };
}