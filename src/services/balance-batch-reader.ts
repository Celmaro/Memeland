/**
 * Kernel T — BalanceBatchReader + EvmBalanceReader.
 * Extracted from wallet-tracker.ts: GMGN-style batch balance reader with
 * in-flight dedupe. wallet-tracker.ts re-exports both for backward compat.
 */

export type EvmBalanceReader = (chain: string, token: string, owner: string) => Promise<bigint | null>;

export interface BatchBalanceRequest {
  chain: string;
  token: string;
  owner: string;
}

/**
 * GMGN-style batch balance reader with in-flight dedupe: concurrent reads of
 * the same chain:token:owner collapse to a single underlying call, and
 * `readMany` maps a batch of requests (fail-closed null per failed read).
 */
export class BalanceBatchReader {
  private inFlight = new Map<string, Promise<bigint | null>>();

  constructor(private readonly readOne: EvmBalanceReader) {}

  private key(req: BatchBalanceRequest): string {
    return `${req.chain}:${req.token.toLowerCase()}:${req.owner.toLowerCase()}`;
  }

  async read(chain: string, token: string, owner: string): Promise<bigint | null> {
    const key = `${chain}:${token.toLowerCase()}:${owner.toLowerCase()}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const p = Promise.resolve(this.readOne(chain, token, owner)).catch(() => null);
    this.inFlight.set(key, p);
    try {
      return await p;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async readMany(requests: BatchBalanceRequest[]): Promise<Map<string, bigint | null>> {
    const list = Array.isArray(requests) ? requests : [];
    const results = new Map<string, bigint | null>();
    await Promise.all(
      list.map(async (req) => {
        results.set(this.key(req), await this.read(req.chain, req.token, req.owner));
      })
    );
    return results;
  }
}