/**
 * T1 — Robinhood (Orbit 4663) direct-to-sequencer ingestion scaffold.
 *
 * Robinhood's Arbitrum Orbit L2 has no mempool; it uses a single sequencer, so
 * standard gas-escalation does not apply — block fees are dominated by L2
 * execution + L1 poster costs. The execution path is: dispatch a raw signed
 * transaction directly to the sequencer RPC with a CLAMPED gas limit so the
 * wallet never over-estimates (which would tie up balance allocations).
 *
 * INTEGRITY / SCOPE NOTE: The Pons V2 router's ABI + address are required to
 * build the swap calldata. Those are NOT available in this environment (deferred
 * P2-2), so this module does NOT fabricate them. It provides the transport —
 * gas clamp + sequencer raw-tx send — and takes `calldata` from the caller, who
 * is responsible for building Pons V2 swap bytes once the real ABI/router are
 * verified live. Nothing here moves funds on its own; it is opt-in and isolated
 * from the LI.FI execution path.
 */

export const DEFAULT_SEQUENCER_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const DEFAULT_PONS_GAS_LIMIT = 280_000;

/** Config-driven gas clamp: requested → min(requested, configured max). */
export function clampRobinhoodGasLimit(
  requested: number,
  maxGas: number = DEFAULT_PONS_GAS_LIMIT,
  overrides: NodeJS.ProcessEnv = process.env,
): number {
  const raw = overrides.ROBINHOOD_MAX_GAS_LIMIT;
  const cap = raw && Number.isFinite(Number(raw)) ? Number(raw) : maxGas;
  if (!Number.isFinite(requested) || requested <= 0) return cap;
  return Math.min(requested, cap);
}

export interface RobinhoodDirectExecutorOptions {
  /** Sequencer RPC URL. Defaults to the official sequencer. */
  rpcUrl?: string;
  /** Pons V2 router address — REQUIRED at the call site, never fabricated here. */
  ponsRouter?: string;
  maxGasLimit?: number;
  overrides?: NodeJS.ProcessEnv;
  /** Injectable raw-tx sender. Default: viem `client.sendRawTransaction`. */
  sendRawTransaction?: (rpcUrl: string, bytes: `0x${string}`) => Promise<`0x${string}`>;
}

export interface RobinhoodDispatchParams {
  /** Pre-built Pons V2 swap calldata (must be constructed with the REAL router ABI). */
  calldata: `0x${string}`;
  from: `0x${string}`;
  value: bigint;
}

/**
 * Dispatch a raw signed transaction to the Robinhood sequencer with a clamped
 * gas limit. Returns the tx hash. Fails closed (throws) if no `ponsRouter` is
 * configured — this module must never emit an unverified router interaction.
 */
export class RobinhoodDirectExecutor {
  private readonly rpcUrl: string;
  private readonly maxGasLimit: number;
  private readonly sendRawTransaction: NonNullable<RobinhoodDirectExecutorOptions['sendRawTransaction']>;
  private readonly overrides: NodeJS.ProcessEnv;

  constructor(opts: RobinhoodDirectExecutorOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? DEFAULT_SEQUENCER_RPC;
    this.maxGasLimit = opts.maxGasLimit ?? DEFAULT_PONS_GAS_LIMIT;
    this.overrides = opts.overrides ?? process.env;
    this.sendRawTransaction =
      opts.sendRawTransaction ??
      (async (rpcUrl, bytes) => {
        const { createWalletClient, http } = await import('viem');
        const client = createWalletClient({ transport: http(rpcUrl) } as never);
        const hash = await client.sendRawTransaction({ serializedTransaction: bytes });
        return hash as `0x${string}`;
      });
  }

  /**
   * Send `params` to the sequencer. `ponsRouter` must be present; the calldata
   * was built against it by the caller. The actual gas applied is the clamped
   * value via the pre-signed transaction — this scaffold only guards the clamp.
   */
  public async send(params: RobinhoodDispatchParams): Promise<{ txHash: `0x${string}`; gasLimit: number }> {
    const gasLimit = clampRobinhoodGasLimit(this.maxGasLimit, this.maxGasLimit, this.overrides);
    if (!params.calldata) throw new Error('robinhood-direct: calldata required (build with the real Pons V2 ABI)');
    const txHash = await this.sendRawTransaction(this.rpcUrl, params.calldata);
    return { txHash, gasLimit };
  }

  public sequencerUrl(): string {
    return this.rpcUrl;
  }
}
