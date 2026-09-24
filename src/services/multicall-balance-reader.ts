/**
 * I1-2 — Multicall3 batch balance reader.
 *
 * Collapses N distinct ERC-20 `balanceOf` reads into ONE `aggregate3` round-trip
 * through the RPC failover pool, cutting the wallet-tracker's RPC load on the
 * copy-trade hot path. Uses the DOCUMENTED per-chain Multicall3 deployments (RH
 * has a native L2 Multicall at 0x2cAC2D…) — never a fresh deploy.
 *
 * Per-chain capability registry + read-only capability check at construction:
 * if a chain has no known/deployed multicall address, or the aggregate3 call
 * fails, we FALL BACK to individual reads (identical results, more round-trips).
 * Fail-closed per read (null on failure) matches the existing BalanceBatchReader.
 */

import { globalRPCFailoverManager } from './rpc-failover.js';

/** ERC-20 balanceOf(address) selector. */
const BALANCE_OF_SELECTOR = '0x70a08231';

/**
 * Documented Multicall3 deployments per chain (verified by providers, not
 * assumed). RH chain ships a native L2 Multicall at this address.
 */
export const MULTICALL3_ADDRESSES: Record<string, string> = {
  rh: '0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1',
  robinhood: '0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1',
  eth: '0xcA11bde05977b3631167028862bE2a173976CA11',
  ethereum: '0xcA11bde05977b3631167028862bE2a173976CA11',
  bsc: '0xcA11bde05977b3631167028862bE2a173976CA11',
  binance: '0xcA11bde05977b3631167028862bE2a173976CA11',
  base: '0xcA11bde05977b3631167028862bE2a173976CA11',
};

/** Env override: MULTICALL3_ADDRESS_RH etc. win over the default map. */
function multicallAddressFor(chain: string): string | undefined {
  const key = chain.toLowerCase();
  const envKey = `MULTICALL3_ADDRESS_${key.toUpperCase()}`;
  const env = process.env[envKey]?.trim();
  if (env) return env;
  return MULTICALL3_ADDRESSES[key];
}

export interface BalanceRead {
  chain: string;
  token: string;
  owner: string;
}

/** Multicall3 `Call3 { target, allowFailure, callData }` aggregate3 payload word. */
function callWord(target: string, callData: string): string {
  const addr = target.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  // allowFailure = 1 word, target = 1 word, callData offset = 1 word (dynamic).
  // The struct head is 3 words (96 bytes), so callData starts at offset 0x60.
  const callDataLen = (callData.replace(/^0x/, '').length / 2).toString(16).padStart(64, '0');
  return `0000000000000000000000000000000000000000000000000000000000000001${addr}${'00'.repeat(63)}60${callDataLen}${callData.replace(/^0x/, '')}`;
}

/** Build a `balanceOf(owner)` eth_call payload for a token. */
function balanceOfPayload(token: string, owner: string): string {
  const ownerAddr = owner.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return `${BALANCE_OF_SELECTOR}${ownerAddr}`;
}

export interface MulticallBalanceReaderOptions {
  /** Optional explicit fetch for tests; defaults to global fetch. */
  fetch?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json: () => Promise<{ result?: string; error?: { message?: string } }> }>;
  /** Skip the read-only capability probe (used by tests / callers that know the chain works). */
  skipProbe?: boolean;
}

/**
 * Reads N balances via a single aggregate3 call. Falls back to individual
 * reads when: no multicall address is known for the chain, the capability
 * probe failed, or the aggregate3 call errors. Per-read fail-closed null.
 */
export class MulticallBalanceReader {
  private readonly fetchFn: MulticallBalanceReaderOptions['fetch'];
  private readonly capable = new Set<string>();
  private readonly probed = new Set<string>();
  private readonly skipProbe: boolean;

  constructor(opts: MulticallBalanceReaderOptions = {}) {
    this.fetchFn = opts.fetch;
    this.skipProbe = opts.skipProbe ?? false;
  }

  private fetch(url: string, init: { method: string; headers: Record<string, string>; body: string }) {
    if (this.fetchFn) return this.fetchFn(url, init);
    return fetch(url, init) as unknown as ReturnType<NonNullable<MulticallBalanceReaderOptions['fetch']>>;
  }

  /**
   * Read the given chain for its multicall address (env override → default map),
   * and probe capability lazily. Returns undefined when multicall is unavailable
   * for the chain — caller then uses individual reads.
   */
  private async multicallUrl(chain: string): Promise<string | undefined> {
    const key = chain.toLowerCase();
    if (this.skipProbe) {
      this.capable.add(key);
      this.probed.add(key);
      return multicallAddressFor(key);
    }
    if (this.probed.has(key)) return this.capable.has(key) ? multicallAddressFor(key) : undefined;
    const address = multicallAddressFor(key);
    if (!address) { this.probed.add(key); return undefined; }
    const rpc = globalRPCFailoverManager.getActiveRPC(key === 'robinhood' || key === 'rh' ? 'rh' : key);
    if (!rpc) { this.probed.add(key); return undefined; }
    this.probed.add(key);
    // Capability probe: aggregate3([]) should succeed if the contract is live.
    try {
      const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: address, data: '0x82ad56cb00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000' }, 'latest'], id: 1 });
      const res = await this.fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (!res.ok) return undefined;
      const data = await res.json();
      if (data.error) return undefined;
      this.capable.add(key);
      return address;
    } catch {
      return undefined;
    }
  }

  /**
   * Read many balances. Returns a Map keyed `chain:token:owner` → balance (or
   * null on any failure). Uses multicall when the chain supports it; otherwise
   * individual reads via `fallbackRead`.
   */
  async readMany(
    reads: BalanceRead[],
    fallbackRead: (chain: string, token: string, owner: string) => Promise<bigint | null>,
  ): Promise<Map<string, bigint | null>> {
    const out = new Map<string, bigint | null>();
    const byChain = new Map<string, BalanceRead[]>();
    for (const r of reads) {
      const k = r.chain.toLowerCase();
      if (!byChain.has(k)) byChain.set(k, []);
      byChain.get(k)!.push(r);
    }
    await Promise.all(
      Array.from(byChain.entries()).map(async ([chain, list]) => {
        const address = await this.multicallUrl(chain);
        if (!address) {
          // Fallback: individual reads (identical results, more round-trips).
          for (const r of list) {
            out.set(`${chain}:${r.token.toLowerCase()}:${r.owner.toLowerCase()}`, await fallbackRead(r.chain, r.token, r.owner));
          }
          return;
        }
        const rpc = globalRPCFailoverManager.getActiveRPC(chain === 'robinhood' || chain === 'rh' ? 'rh' : chain);
        if (!rpc) { for (const r of list) out.set(`${chain}:${r.token.toLowerCase()}:${r.owner.toLowerCase()}`, await fallbackRead(r.chain, r.token, r.owner)); return; }
        const calls = list.map((r) => callWord(address === 'rh' ? r.token : r.token, balanceOfPayload(r.token, r.owner)));
        const data = `0x82ad56cb` + encodeABI(calls); // aggregate3
        try {
          const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: address, data }, 'latest'], id: 1 });
          const res = await this.fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
          if (!res.ok) throw new Error('multicall http');
          const json = await res.json();
          if (json.error) throw new Error(json.error.message ?? 'multicall error');
          const decoded = decodeAggregate3Result(json.result ?? '0x');
          list.forEach((r, i) => {
            const value = decoded[i];
            out.set(`${chain}:${r.token.toLowerCase()}:${r.owner.toLowerCase()}`, value === null ? null : value);
          });
        } catch {
          // Multicall failed → individual fallback for this chain.
          for (const r of list) out.set(`${chain}:${r.token.toLowerCase()}:${r.owner.toLowerCase()}`, await fallbackRead(r.chain, r.token, r.owner));
        }
      }),
    );
    return out;
  }
}

/** Encode an array of already-packed Call3 struct words into ABI array form. */
function encodeABI(structs: string[]): string {
  const words = structs.join('');
  // Head: offset to tail = 0x20, then length, then tail (concatenated structs).
  const len = structs.length.toString(16).padStart(64, '0');
  return `${'00'.repeat(31)}20${len}${words}`;
}

/**
 * Decode Multicall3 aggregate3 return: (bool[], bytes[]). Returns the uint256
 * first word of each bytes result, or null for a failed call (allowFailure).
 */
function decodeAggregate3Result(resultHex: string): (bigint | null)[] {
  const hex = resultHex.startsWith('0x') ? resultHex.slice(2) : resultHex;
  if (hex.length < 64) return [];
  // Head: (offset to successes array, offset to returnData array) = two words.
  const successOffset = Number(BigInt('0x' + hex.slice(0, 64)));
  const successLen = Number(BigInt('0x' + hex.slice(successOffset * 2, successOffset * 2 + 64)));
  const successes: number[] = [];
  for (let i = 0; i < successLen; i++) {
    const start = successOffset * 2 + 64 + i * 64;
    successes.push(Number(BigInt('0x' + hex.slice(start, start + 64))));
  }
  // returnData array follows the successes array in the head; locate its offset
  // from the second head word.
  const returnOffset = Number(BigInt('0x' + hex.slice(64, 128)));
  const returnLen = Number(BigInt('0x' + hex.slice(returnOffset * 2, returnOffset * 2 + 64)));
  const out: (bigint | null)[] = [];
  let cursor = returnOffset * 2 + 64;
  for (let i = 0; i < returnLen; i++) {
    const dataOffset = Number(BigInt('0x' + hex.slice(cursor, cursor + 64))); cursor += 64;
    const dataLen = Number(BigInt('0x' + hex.slice(cursor, cursor + 64))); cursor += 64;
    const dataStart = cursor;
    if (successes[i] && dataLen >= 32) {
      out.push(BigInt('0x' + hex.slice(dataStart, dataStart + 64)));
    } else {
      out.push(null);
    }
    cursor = dataStart + dataLen * 2;
  }
  return out;
}
