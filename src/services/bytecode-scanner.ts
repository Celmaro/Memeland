import { globalRPCFailoverManager } from './rpc-failover.js';
import { TtlCache } from '../cache/ttl-cache.js';

/**
 * Kernel D / NERVE A11. Deterministic bytecode scanner that flags a curated
 * deny-list of transfer-restricting and honeypot selectors when they appear as
 * PUSH4-wrapped constants in the deployed hex. Pure string scan, no chain I/O —
 * except scanContract(), which fetches the deployed code from the RPC failover
 * pool (keyless) so the audit has a GMGN-independent leg.
 */

/** EVM PUSH4 opcode byte (0x63) as hex. */
export const PUSH4_OPCODE = '63';

/** Maps chain names to the failover pool key for eth_getCode. */
const CHAIN_TO_POOL: Record<string, 'rh' | 'eth' | 'bsc' | 'base'> = {
  robinhood: 'rh',
  rh: 'rh',
  eth: 'eth',
  ethereum: 'eth',
  bsc: 'bsc',
  binance: 'bsc',
  base: 'base',
};

interface DenyRule {
  selector: string;
  label: string;
}

/** Curated deny-list of 4-byte selectors that gate or restrict sells. */
const DENY_LIST: readonly DenyRule[] = [
  { selector: '0x42966c68', label: 'PUSH4 0x42966c68 burn-restrict found' },
  { selector: '0xbc197c81', label: 'PUSH4 0xbc197c81 batch-transfer gate found' },
  { selector: '0x4a7d80d3', label: 'PUSH4 0x4a7d80d3 honeypot marker found' },
];

export interface ScanResult {
  flagged: boolean;
  findings: string[];
}

/** Lowercases, strips a 0x prefix, and rejects anything that is not clean hex. */
function normalize(bytecode: string): string {
  const hex = bytecode.trim().replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]*$/.test(hex) ? hex : '';
}

/**
 * B#3 (audit) — ABI/bytecode "seen identical contract before, skip the call"
 * cache. The audit recommended a `bytecodeHash -> ABI` cache so identical proxy
 * contracts don't re-pay the explorer/RPC call every pass. This scanner does not
 * fetch explorer ABIs, but it DOES re-fetch deployed code via `eth_getCode` for
 * every screened token on every pass — the real cost-bearing call. So the cache
 * keys on deployed-code bytes: the SAME address skips `eth_getCode` entirely
 * within TTL (the core win), and DIFFERENT addresses whose deployed code hashes
 * identically skip the redundant string-scan (share one result). Fail-open: a
 * cache lookup never blocks a scan — a miss just falls through to a fetch.
 */
export interface BytecodeScannerOptions {
  /** How long a fetched bytecode scan is reused. Default 15 min. */
  cacheTtlMs?: number;
  /** Optional LRU cap on cached addresses. Default 2000. */
  maxCacheEntries?: number;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
}

/** Stable 32-bit FNV-1a over the normalized hex → string hash (deterministic). */
function codeHashOf(hex: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < hex.length; i += 1) {
    h ^= hex.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export class BytecodeScanner {
  private readonly addressCache: TtlCache<{ codeHash: string; scan: ScanResult }>;
  private readonly hashCache: TtlCache<ScanResult>;

  constructor(opts: BytecodeScannerOptions = {}) {
    const ttlMs = opts.cacheTtlMs ?? 15 * 60 * 1000;
    const maxEntries = opts.maxCacheEntries ?? 2000;
    this.addressCache = new TtlCache<{ codeHash: string; scan: ScanResult }>({ ttlMs, maxEntries, now: opts.now });
    this.hashCache = new TtlCache<ScanResult>({ ttlMs, maxEntries, now: opts.now });
  }

  scan(bytecode: string): ScanResult {
    const hex = normalize(bytecode);
    if (hex.length === 0) return { flagged: false, findings: [] };
    const findings = DENY_LIST.filter((rule) =>
      hex.includes(`${PUSH4_OPCODE}${rule.selector.slice(2)}`),
    ).map((rule) => rule.label);
    return { flagged: findings.length > 0, findings };
  }

  /**
   * Fetches deployed code through the RPC failover pool and scans it, reusing a
   * cached scan for the same address (skips `eth_getCode`) or the same deployed
   * bytes (skips the redundant string-scan) within TTL. Fail-soft: any fetch
   * error returns an empty (unflagged) scan — the bytecode scan is an extra
   * red-flag detector, not a gate; it must never fail-closed on transport.
   */
  async scanContract(
    chain: string,
    address: string,
    fetcher?: (url: string) => Promise<string>,
  ): Promise<ScanResult> {
    const addrKey = `${String(chain).toLowerCase()}:${address.toLowerCase()}`;
    const cached = this.addressCache.get(addrKey);
    if (cached) return cached.scan;

    const poolKey = CHAIN_TO_POOL[String(chain).toLowerCase()];
    if (!poolKey) return { flagged: false, findings: [] };
    const rpc = globalRPCFailoverManager;
    const url = rpc.getActiveRPC(poolKey);
    if (!url) return { flagged: false, findings: [] };
    const getCode = fetcher ?? (async (u) => {
      const res = await fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getCode', params: [address, 'latest'], id: 1 }),
      });
      if (!res.ok) throw new Error(`eth_getCode HTTP ${res.status}`);
      const data = (await res.json()) as { result?: string; error?: { message?: string } };
      if (data.error) throw new Error(`eth_getCode: ${data.error.message}`);
      return data.result ?? '0x';
    });
    try {
      const code = await getCode(url);
      const hex = normalize(code);
      const codeHash = codeHashOf(hex);
      // Identical deployed bytes already scanned for a DIFFERENT address → reuse.
      const shared = this.hashCache.get(codeHash);
      if (shared) {
        this.addressCache.set(addrKey, { codeHash, scan: shared });
        return shared;
      }
      const scan = this.scan(code);
      this.addressCache.set(addrKey, { codeHash, scan });
      this.hashCache.set(codeHash, scan);
      return scan;
    } catch {
      return { flagged: false, findings: [] };
    }
  }
}
