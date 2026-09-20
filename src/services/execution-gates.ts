/**
 * Execution-gates — shared wiring that connects the pure fail-closed gate modules
 * (Q15 SafeConfigRegistry, rh-execution-core TxLock) to the LIVE execution call
 * sites (index.ts AUTO path + interaction-buttons.ts approve path).
 *
 * Policy:
 *  - SAFETY: enforced only when SAFETY_GATE_ENFORCED=true (opt-in, not silent). When
 *    enforced, a safe-config must exist AND be unexpired + explicitly safe or every
 *    fill is refused (read-only default). The operator creates the safe-config via
 *    `operator` remediation. When NOT enforced, fills proceed as today (legacy) and a
 *    warning is logged — so wiring this never silently bricks the running bot.
 *  - TX LOCK: always enforced — per-token serialization is pure and safe.
 *  - SELLABILITY (Quoter honeypot): exported hook only. Needs a real eth_call transport
 *    to be fail-closed; until one is configured the call site should NOT pass
 *    `sellability` (the safety gate remains the active security gate).
 */

import fs from 'fs';
import path from 'path';
import { SafeConfigRegistry, type SafeConfigIO } from './safety-registry.js';
import { CapabilityRBAC } from './exec-governance.js';
import { TxLock } from './rh-execution-core.js';

function safeConfigFilePath(): string {
  return path.join(process.cwd(), 'database', 'safe-config.json');
}

const safeIO: SafeConfigIO = {
  read() {
    try {
      return fs.readFileSync(safeConfigFilePath(), 'utf-8');
    } catch {
      return null; // absent file → no safe-config → fail-closed when enforced
    }
  },
  write(payloadJson: string) {
    fs.mkdirSync(path.dirname(safeConfigFilePath()), { recursive: true });
    fs.writeFileSync(safeConfigFilePath(), payloadJson, 'utf-8');
  },
};

// Read-only default: only `operator` may remediate; everything else is denied.
const roleCapabilities: Record<string, string[]> = {
  operator: ['safety:remediate'],
  agent: [],
};

/** Shared safe-config registry persisted to database/safe-config.json. */
export const executionSafety = new SafeConfigRegistry(safeIO, new CapabilityRBAC(roleCapabilities));

/** Per-token tx serializer shared by both execution paths. */
export const executionTxLock = new TxLock();

const SAFE_ROLE = () => process.env.SAFE_ROLE || 'agent';

/**
 * Safety gate for executeMemeBuy. Enforced only when SAFETY_GATE_ENFORCED=true;
 * otherwise a benign pass with a warning (legacy behavior preserved).
 */
export function gateSafety(): { safe: boolean; reason: string } {
  const enforced = process.env.SAFETY_GATE_ENFORCED === 'true';
  const res = executionSafety.isSafe(SAFE_ROLE());
  if (!enforced) {
    console.warn(`[EXEC] SAFETY_GATE_ENFORCED not set — safety gate BYPASSED (reads ${res.reason})`);
    return { safe: true, reason: 'safety gate not enforced (SAFETY_GATE_ENFORCED unset)' };
  }
  return res;
}

/** TxLock gate: acquire a per-token lock around a fill. */
export function gateTxLock() {
  return executionTxLock;
}

/**
 * Quoter-honeypot sellability gate — returns a transport-gated check. Until a real
 * eth_call Quoter transport is configured this reports "not configured" (DO NOT pass
 * to executeMemeBuy in that case; keep it a no-op hook).
 */
export function gateSellability() {
  return {
    check: async (tokenAddress: string): Promise<{ sellable: boolean; reason: string }> => ({
      sellable: true,
      reason: `sellability check not configured — not enforced (token ${tokenAddress})`,
    }),
  };
}