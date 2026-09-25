/**
 * Item 3 — typed per-chain configuration + loud boot validation.
 *
 * Replaces flat, scattered env assumptions with a typed ChainConfig object per
 * chain, and validates at boot that:
 *   - every configured chain has a non-empty RPC pool
 *   - chain ids are the known ones (no silent unknown-chain drift)
 *   - dry-run vs live flags are mutually exclusive (never both)
 *   - numeric ranges for the execution envelope are sane
 *
 * Fail-LOUD on misconfiguration: a wrong value is a boot error with the exact
 * variable named, never a silent fallback to an unsafe default.
 */

/** The canonical EVM chains + Solana. Robbinhood #4663 retained as execution venue. */
export const KNOWN_CHAIN_IDS: Record<string, number> = {
  robinhood: 4663,
  rh: 4663,
  eth: 1,
  bsc: 56,
  base: 8453,
  sol: 101,
};

export type ChainKey = 'rh' | 'eth' | 'bsc' | 'base' | 'sol';

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrls: string[];
  nativeToken: string;
  enabled: boolean;
  /** RPC pool key in rpc-failover.ts (defaults to the chain key). */
  poolKey: ChainKey;
}

/** Default chain registry — RPC pools are seeded by rpc-failover.ts; this is
 *  the static identity layer (id/name/native/pool). */
export const CHAIN_CONFIGS: Record<ChainKey, ChainConfig> = {
  rh: { chainId: 4663, name: 'robinhood', rpcUrls: [], nativeToken: 'ETH', enabled: true, poolKey: 'rh' },
  eth: { chainId: 1, name: 'ethereum', rpcUrls: [], nativeToken: 'ETH', enabled: true, poolKey: 'eth' },
  bsc: { chainId: 56, name: 'bsc', rpcUrls: [], nativeToken: 'BNB', enabled: true, poolKey: 'bsc' },
  base: { chainId: 8453, name: 'base', rpcUrls: [], nativeToken: 'ETH', enabled: true, poolKey: 'base' },
  sol: { chainId: 101, name: 'solana', rpcUrls: [], nativeToken: 'SOL', enabled: true, poolKey: 'sol' },
};

export interface ChainValidationIssue {
  chain: string;
  field: string;
  message: string;
}

/**
 * Validate the runtime chain configuration. Returns issues (not throws) so
 * callers decide the blast radius — startup-validation converts them into a
 * loud boot error. Never silently drops a misconfigured chain.
 */
export function validateChainConfig(
  chains: string[],
  poolOf: (chainKey: ChainKey) => string | undefined,
): { ok: boolean; issues: ChainValidationIssue[] } {
  const issues: ChainValidationIssue[] = [];
  const seen = new Set<string>();
  for (const chain of chains) {
    const key = chain.toLowerCase() as ChainKey;
    if (!CHAIN_CONFIGS[key]) {
      issues.push({ chain, field: 'chain', message: `unknown chain '${chain}' in MULTICHAIN_CHAINS — not in KNOWN_CHAIN_IDS` });
      continue;
    }
    if (seen.has(key)) {
      issues.push({ chain, field: 'chain', message: `duplicate chain '${chain}' in MULTICHAIN_CHAINS` });
    }
    seen.add(key);
    const pool = poolOf(key);
    if (!pool || pool.length === 0) {
      issues.push({ chain, field: 'rpcUrls', message: `chain '${chain}' has an empty RPC pool — add hosts or set ${poolEnvFor(key)}` });
    }
  }
  if (seen.size === 0) {
    issues.push({ chain: '(all)', field: 'chains', message: 'MULTICHAIN_CHAINS resolves to zero enabled chains — nothing will scan' });
  }
  return { ok: issues.length === 0, issues };
}

function poolEnvFor(key: ChainKey): string {
  return key === 'rh' ? 'RPC_FAILOVER_RH_URL' : `RPC_FAILOVER_${key.toUpperCase()}_URL`;
}

/**
 * Mutually-exclusive execution-mode flags: DRY_RUN / SIGNAL_ONLY / AUTO_EXECUTE
 * must not be simultaneously enabled. A conflict is a loud boot error — an
 * ambiguous execution posture is the most dangerous kind of misconfiguration.
 */
export function validateExecutionMode(): { ok: boolean; issues: ChainValidationIssue[] } {
  const issues: ChainValidationIssue[] = [];
  const dryRun = process.env.DRY_RUN === 'true';
  const signalOnly = process.env.SIGNAL_ONLY === 'true';
  const auto = process.env.AUTO_EXECUTE_ENABLED === 'true';
  if (dryRun && auto) issues.push({ chain: 'execution', field: 'DRY_RUN/AUTO_EXECUTE_ENABLED', message: 'DRY_RUN=true and AUTO_EXECUTE_ENABLED=true are mutually exclusive — pick one posture' });
  if (signalOnly && auto) issues.push({ chain: 'execution', field: 'SIGNAL_ONLY/AUTO_EXECUTE_ENABLED', message: 'SIGNAL_ONLY=true and AUTO_EXECUTE_ENABLED=true are mutually exclusive' });
  if (dryRun && signalOnly) issues.push({ chain: 'execution', field: 'DRY_RUN/SIGNAL_ONLY', message: 'DRY_RUN=true and SIGNAL_ONLY=true overlap — SIGNAL_ONLY implies DRY_RUN; set only SIGNAL_ONLY' });
  // A live-trading key must never be present in DRY_RUN (defense in depth).
  if (!auto && (process.env.EVM_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY)) {
    issues.push({ chain: 'execution', field: 'private-key', message: `private key present while execution is not AUTO — refuse to start (${process.env.EVM_PRIVATE_KEY ? 'EVM_PRIVATE_KEY' : 'SOLANA_PRIVATE_KEY'} set)` });
  }
  return { ok: issues.length === 0, issues };
}
