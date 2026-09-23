import { globalRPCFailoverManager } from './rpc-failover.js';

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

export class BytecodeScanner {
  scan(bytecode: string): ScanResult {
    const hex = normalize(bytecode);
    if (hex.length === 0) return { flagged: false, findings: [] };
    const findings = DENY_LIST.filter((rule) =>
      hex.includes(`${PUSH4_OPCODE}${rule.selector.slice(2)}`),
    ).map((rule) => rule.label);
    return { flagged: findings.length > 0, findings };
  }

  /**
   * Fetches deployed code through the RPC failover pool and scans it. Fail-soft:
   * any fetch error returns an empty (unflagged) scan — the bytecode scan is an
   * extra red-flag detector, not a gate; it must never fail-closed on transport.
   */
  async scanContract(
    chain: string,
    address: string,
    fetcher?: (url: string) => Promise<string>,
  ): Promise<ScanResult> {
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
      return this.scan(code);
    } catch {
      return { flagged: false, findings: [] };
    }
  }
}
