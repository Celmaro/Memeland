/**
 * T1 — Deterministic local EVM nonce manager.
 *
 * Public RPC `pending` nonce queries are unreliable during rapid bursts; a
 * single desynchronized nonce stalls the whole pipeline. This manager sequences
 * nonces locally: it seeds once from the RPC (`latest`) and increments
 * in-process thereafter, serializing concurrent grants with a lock so bursts
 * never receive the same nonce. `reset()` re-seeds (e.g. after a dropped/replaced
 * tx or process-level nonce collision).
 *
 * Fail-open: if the provider throws on the seed read, `getAndIncrement` rethrows
 * (a missing nonce MUST NOT silently fabricate a value); callers gate MEV use so
 * this never affects the LI.FI execution path.
 *
 * The provider is a thin viem-shaped seam (`getTransactionCount(address, 'latest')`),
 * injectable in tests.
 */
export interface NonceProvider {
  getTransactionCount(address: string, blockTag?: 'latest' | 'pending'): Promise<number>;
}

export class LocalNonceManager {
  private currentNonce = -1;
  private lock = false;
  private readonly pollMs: number;

  constructor(
    private readonly provider: NonceProvider,
    pollMs = 5,
  ) {
    this.pollMs = pollMs;
  }

  /** Assign the next nonce, seeding from the provider on first use. */
  public async getAndIncrement(address: string): Promise<number> {
    while (this.lock) {
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    this.lock = true;
    try {
      if (this.currentNonce === -1) {
        this.currentNonce = await this.provider.getTransactionCount(address, 'latest');
      }
      const assigned = this.currentNonce;
      this.currentNonce += 1;
      return assigned;
    } finally {
      this.lock = false;
    }
  }

  /** Re-seed on the next call (after a dropped/replaced tx or detected collision). */
  public reset(): void {
    this.currentNonce = -1;
  }

  public peek(): number {
    return this.currentNonce;
  }
}