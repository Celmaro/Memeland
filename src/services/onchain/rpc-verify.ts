/**
 * RpcVerify — independent on-chain verification over the RPC failover pool.
 *
 * Blockscout (the `verify` role) confirms transactions from the explorer's
 * indexed view. RpcVerify is the SECOND, independent confirmation straight from
 * the chain via `eth_getTransactionReceipt` on the active RPC for a chain. Two
 * independent confirmations cut false positives at the decision gate with near-
 * zero marginal cost now that the failover pool is redundant/keyed.
 *
 * This is the primitive the VerifyCoordinator consumes; it is intentionally
 * small, transport-only, and fail-soft (returns `null` on transport/parse error
 * so callers degrade to "unconfirmed", never a false confirmation).
 */

import { globalRPCFailoverManager } from '../rpc-failover.js';

export type RpcVerifyChain = 'rh' | 'eth' | 'bsc' | 'base';

export interface RpcTxReceipt {
  chain: RpcVerifyChain;
  txHash: string;
  /** 0x1 = success, 0x0 = reverted. */
  status: boolean;
  /** True when the transaction is mined (a receipt exists). */
  confirmed: boolean;
  blockNumber?: number;
  from?: string;
  to?: string;
  logs: unknown[];
}

export interface RpcVerifyOptions {
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
    ok: boolean;
    json: () => Promise<{ result?: unknown; error?: unknown }>;
  }>;
  getActiveRPC?: (chain: string) => string | undefined;
}

/** Chain key → RPC pool key (rh/eth/bsc/base map 1:1 onto the failover pool). */
const POOL_KEY: Record<RpcVerifyChain, string> = { rh: 'rh', eth: 'eth', bsc: 'bsc', base: 'base' };

export class RpcVerify {
  private readonly fetch: NonNullable<RpcVerifyOptions['fetch']>;
  private readonly getActiveRPC: NonNullable<RpcVerifyOptions['getActiveRPC']>;

  constructor(opts: RpcVerifyOptions = {}) {
    this.fetch =
      opts.fetch ??
      ((url, init) =>
        (globalThis as { fetch: (url: string, init: unknown) => Promise<Response> }).fetch(url, init) as Promise<{
          ok: boolean;
          json: () => Promise<{ result?: unknown; error?: unknown }>;
        }>);
    this.getActiveRPC = opts.getActiveRPC ?? ((chain) => globalRPCFailoverManager.getActiveRPC(chain));
  }

  /**
   * Confirm a transaction on-chain via eth_getTransactionReceipt. Returns null
   * when the receipt is absent (not yet mined) or on any transport/parse error
   * (fail-soft → caller treats it as unconfirmed, never a false confirmation).
   */
  public async getTransactionReceipt(chain: RpcVerifyChain, txHash: string): Promise<RpcTxReceipt | null> {
    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) return null;
    const rpc = this.getActiveRPC(POOL_KEY[chain]);
    if (!rpc) return null;
    try {
      const res = await this.fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionReceipt', params: [txHash], id: 1 }),
      });
      if (!res.ok) return null;
      const body = await res.json();
      const receipt = body?.result as
        | { status?: string; blockNumber?: string; from?: string; to?: string | null; logs?: unknown[] }
        | null;
      if (!receipt) return null; // not mined
      const block = receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : undefined;
      return {
        chain,
        txHash,
        status: receipt.status === '0x1',
        confirmed: true,
        blockNumber: Number.isFinite(block) ? block : undefined,
        from: receipt.from,
        to: receipt.to ?? undefined,
        logs: Array.isArray(receipt.logs) ? receipt.logs : [],
      };
    } catch {
      // R1: demote this host so the next call uses a different RPC.
      globalRPCFailoverManager.reportRPCFailure(POOL_KEY[chain], rpc);
      return null;
    }
  }

  /**
   * Convenience: does the transaction exist AND succeed on-chain? Independent of
   * any explorer. Used as the RPC half of a two-source verify cross-check.
   */
  public async confirmSuccess(chain: RpcVerifyChain, txHash: string): Promise<boolean> {
    const receipt = await this.getTransactionReceipt(chain, txHash);
    return receipt?.confirmed === true && receipt.status === true;
  }
}

/** On-chain existence check result for a token address / mint. */
export interface ExistenceCheck {
  exists: boolean;
  /** True when the oracle could not reach the chain (transport failure). */
  transportDown: boolean;
}

export interface ExistencePrims {
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
    ok: boolean;
    json: () => Promise<{ result?: unknown; error?: unknown }>;
  }>;
  getActiveRPC?: (chain: string) => string | undefined;
}

async function rpcPost(
  chainKey: string,
  method: string,
  params: unknown[],
  deps: ExistencePrims,
): Promise<{ result?: unknown; error?: unknown } | null> {
  const rpc = deps.getActiveRPC
    ? deps.getActiveRPC(chainKey)
    : globalRPCFailoverManager.getActiveRPC(chainKey);
  if (!rpc) return null;
  const fetchImpl = deps.fetch ?? ((url, init) => (globalThis as { fetch: (url: string, init: unknown) => Promise<Response> }).fetch(url, init) as Promise<{ ok: boolean; json: () => Promise<{ result?: unknown; error?: unknown }> }>);
  try {
    const res = await fetchImpl(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // R1: demote this host so the next call uses a different RPC.
    globalRPCFailoverManager.reportRPCFailure(chainKey, rpc);
    return null;
  }
}

/**
 * EVM oracle: does an ERC-20 token contract exist at `address`? eth_getCode is
 * non-empty for a real contract; '0x' means no contract (an EOA or empty
 * address). Any transport failure surface returns transportDown=true so the
 * hint gate can fail open rather than mislabel a live token as fake.
 */
export async function evmTokenExists(
  chain: RpcVerifyChain,
  address: string,
  deps: ExistencePrims = {},
): Promise<ExistenceCheck> {
  const body = await rpcPost(POOL_KEY[chain], 'eth_getCode', [address], deps);
  if (body === null) return { exists: false, transportDown: true };
  const result = body.result;
  if (typeof result !== 'string') return { exists: false, transportDown: true };
  // '0x' → empty bytecode → no contract at that address.
  return { exists: result.length > 2 && result !== '0x', transportDown: false };
}

/**
 * Solana oracle: does the token mint exist / has token accounts?
 * getTokenLargestAccounts returns `value` when the mint is real and held;
 * a parse/RPC error surface (invalid param) typically means the address is not
 * a valid mint. We treat a definitive RPC `error` payload as `exists:false`
 * (the mint is not real), and transport failures as transportDown=true.
 */
export async function solanaMintExists(
  mint: string,
  deps: ExistencePrims = {},
): Promise<ExistenceCheck> {
  const body = await rpcPost('sol', 'getTokenLargestAccounts', [mint], deps);
  if (body === null) return { exists: false, transportDown: true };
  if (body.error) return { exists: false, transportDown: false };
  const value = (body.result as { value?: unknown } | undefined)?.value;
  return { exists: Array.isArray(value) && value.length > 0, transportDown: false };
}
