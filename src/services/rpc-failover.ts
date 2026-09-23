import { getEnvString } from '../config/config.js';

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
 * - sol: publicnode OK (solana-core 4.2.2); official api.mainnet-beta TIMED OUT → not a default;
 *         drpc sol is paid-only → not a default
 */
const CHAIN_RPC_SPEC: Record<RpcChainKey, ChainRpcSpec> = {
  rh: {
    envVar: 'EVM_ROBINHOOD_RPC_URL',
    defaults: [
      'https://rpc.mainnet.chain.robinhood.com',
      'https://robinhood-rpc.publicnode.com/',
      'https://robinhood.drpc.org/',
    ],
    chainId: '0x1237',
  },
  eth: {
    envVar: 'EVM_ETH_RPC_URL',
    defaults: [
      'https://ethereum-rpc.publicnode.com/',
      'https://eth.drpc.org/',
      'https://public-eth.nownodes.io/',
    ],
    chainId: '0x1',
  },
  bsc: {
    envVar: 'EVM_BSC_RPC_URL',
    defaults: [
      'https://bsc-rpc.publicnode.com/',
      'https://bsc.drpc.org/',
      'https://public-bsc.nownodes.io/',
    ],
    chainId: '0x38',
  },
  base: {
    envVar: 'EVM_BASE_RPC_URL',
    defaults: [
      'https://base-rpc.publicnode.com/',
      'https://base.drpc.org/',
      'https://mainnet.base.org/',
    ],
    chainId: '0x2105',
  },
  sol: {
    envVar: 'SOLANA_RPC_URL',
    defaults: ['https://solana-rpc.publicnode.com/'],
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
          try {
            const body = CHAIN_RPC_SPEC[chain].chainId
              ? '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
              : '{"jsonrpc":"2.0","method":"getVersion","params":[],"id":1}';
            const res = await fetch(s.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
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
  }

  public getActiveRPC(chain: string): string {
    const key = resolveChainKey(chain);
    const healthy = this.status[key]
      .filter((s) => s.healthy)
      .sort((a, b) => a.latencyMs - b.latencyMs);
    return healthy[0]?.url ?? this.endpoints[key][0] ?? '';
  }

  public getLastProbeAt(): number {
    return this.lastProbeAt;
  }

  public reportRPCFailure(chain: string, url: string): void {
    const key = resolveChainKey(chain);
    const entry = this.status[key].find((s) => s.url === url);
    if (entry) entry.healthy = false;
  }
}

export const globalRPCFailoverManager = new RPCFailoverManager();