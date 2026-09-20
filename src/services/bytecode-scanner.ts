/**
 * Kernel D / NERVE A11. Deterministic bytecode scanner that flags a curated
 * deny-list of transfer-restricting and honeypot selectors when they appear as
 * PUSH4-wrapped constants in the deployed hex. Pure string scan, no chain I/O.
 */

/** EVM PUSH4 opcode byte (0x63) as hex. */
export const PUSH4_OPCODE = '63';

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
}
