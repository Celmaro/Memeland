import { getEnvString } from '../config/config.js';
import { globalRateLimiter } from './provider-rate-limiter.js';

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

  constructor() {
    const configured = (() => {
      const raw = getEnvString('RPC_FAILOVER_URLS');
      if (!raw) return {} as Record<string, string[]>;
      try {
        const parsed = JSON.parse(raw) as unknown;
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
            // Even a 2xx can be a JSON-RPC error (e.g. "method unsupported"); treat those as unhealthy.
            let healthy = res.ok;
            if (healthy && CHAIN_RPC_SPEC[chain].chainId) {
              try {
                const json = (await res.json()) as { result?: string; error?: { code?: number } };
                healthy = json.result === CHAIN_RPC_SPEC[chain].chainId;
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
      .filter((s) => s.healthy)
      .sort((a, b) => a.latencyMs - b.latencyMs);
    if (healthy[0]) return healthy[0].url;
    // No healthy host: prefer a default that has NOT been reported failed
    // since the last probe, so reportRPCFailure → retry actually moves to a
    // different host instead of reselecting the one just marked bad.
    const fallback = this.endpoints[key].find((url) => !this.failedUrls.has(url));
    return fallback ?? this.endpoints[key][0] ?? '';
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
}

export const globalRPCFailoverManager = new RPCFailoverManager();