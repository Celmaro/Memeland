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
import { sizePosition } from '../orchestrator/position-sizing.js';
import { CostGate } from './cost-gating.js';
import { simulateFill } from './fill-simulation.js';
import { ApprovalGovernance } from './exec-governance.js';
import { atomicWriteJsonSync } from '../storage/atomic-file-store.js';

/** Read a positive env number with a default (invalid/absent → default). */
function envNum(key: string, def: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

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
    atomicWriteJsonSync(safeConfigFilePath(), JSON.parse(payloadJson));
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

// ── Q07/Q08/Q13/Q11 providers (wired into executeMemeBuy via the live call sites) ──

/** Q07 multi-constraint sizer — clamps to the binding constraint, refuses below floor. */
export function gateSizer() {
  const maxNotionalUsd = envNum('MAX_NOTIONAL_USD', 2000);
  const minUsd = envNum('MIN_TRADE_USD', 0);
  return {
    clamp(desiredUsd: number): { allowed: boolean; amountUsd: number; reason?: string } {
      const r = sizePosition(desiredUsd, { maxNotionalUsd, minUsd });
      if (r.refused) return { allowed: false, amountUsd: 0, reason: r.reason || `constraint ${r.constraint}` };
      return { allowed: true, amountUsd: r.sizeUsd };
    },
  };
}

/** Q08 fill simulation — refuses zero/illiquid depth and impact over cap. */
export function gateFillSim() {
  const maxImpact = envNum('MAX_FILL_IMPACT_PCT', 5);
  return {
    check(input: { amountUsd: number; midPriceUsd: number; liquidityUsd?: number }): { allowed: boolean; impactPct: number; reason?: string } {
      const r = simulateFill({ notionalUsd: input.amountUsd, midPriceUsd: input.midPriceUsd, depth: { liquidityUsd: input.liquidityUsd } });
      if (r.refused) return { allowed: false, impactPct: 0, reason: r.reason || 'zero/illiquid depth' };
      if (r.impactPct > maxImpact) return { allowed: false, impactPct: r.impactPct, reason: `impact ${r.impactPct.toFixed(1)}% > cap ${maxImpact}%` };
      return { allowed: true, impactPct: r.impactPct };
    },
  };
}

/** Q13 cumulative cost gate — a fill must stay within the config cost budget. Opt-in:
 *  only enforced when COST_CAP_USD is set (so wiring never silently bricks a running bot). */
let costGateSingleton: CostGate | null = null;
let costGateEnabled = false;
export function gateCostGate() {
  if (!costGateSingleton) {
    const raw = process.env.COST_CAP_USD;
    costGateEnabled = raw !== undefined && raw !== '';
    costGateSingleton = new CostGate(costGateEnabled ? envNum('COST_CAP_USD', 50) : Number.MAX_SAFE_INTEGER);
    if (!costGateEnabled) console.warn('[EXEC] COST_CAP_USD not set — cost gate not enforced');
  }
  return {
    trySpend(costUsd: number): { allowed: boolean; reason?: string } {
      if (!costGateEnabled) return { allowed: true };
      if (!costGateSingleton!.canSubmit(costUsd)) {
        return { allowed: false, reason: `cumulative cost budget exhausted (spent $${costGateSingleton!.spentUsd.toFixed(2)})` };
      }
      costGateSingleton!.recordFill(costUsd);
      return { allowed: true };
    },
  };
}

/** Q11 execution governance — idempotent reservation + hash-locked receipt. */
let governanceSingleton: ApprovalGovernance | null = null;
export function gateGovernance() {
  if (!governanceSingleton) governanceSingleton = new ApprovalGovernance();
  return {
    reserve(order: { nonce: string; payload: string }) {
      return governanceSingleton!.reserve(order);
    },
    issue(order: { nonce: string; payload: string }) {
      return governanceSingleton!.issueReceipt(order);
    },
  };
}
