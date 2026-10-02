import { assertStartupConfig } from '../config/startup-validation.js';
import { getExecutionMode, isDryRun as isDryRunMode, isAutoExecute, isSignalOnly } from '../config/config.js';
import { globalRPCFailoverManager } from '../services/rpc-failover.js';
import { validateChainConfig, validateExecutionMode } from '../config/chain-config.js';
import { executableChainsFromEnv } from '../config/execution-registry.js';
import { printProviderBanner } from './provider-banner.js';

/** Central startup guard: same env checks as before, packaged as a boot module. */
export function bootstrapStartupConfig(): void {
  try {
    assertStartupConfig();
  } catch (err: any) {
    console.error(`[CONFIG] REFUSING TO START: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Item 3 — loud runtime config validation. AUTO_EXECUTE misconfig is a hard
 * boot failure; in DRY_RUN/SIGNAL_ONLY the same issues are loud warnings (the
 * bot can still screen, but the operator is told exactly what is wrong).
 */
export function validateRuntimeConfig(): void {
  // Canonial executable set (defaults to the full 5-chain scope when
  // MULTICHAIN_CHAINS is unset) — same resolver the execution layer uses.
  const chains = [...executableChainsFromEnv()];
  const chainRes = validateChainConfig(chains, (key) => {
    const pool = globalRPCFailoverManager.getRpcUrls(key);
    return pool && pool.length > 0 ? pool[0] : undefined;
  });
  const modeRes = validateExecutionMode();
  const all = [...chainRes.issues, ...modeRes.issues];
  if (all.length === 0) return;
  const header = isAutoExecute() ? '[CONFIG] REFUSING TO START (AUTO_EXECUTE with invalid config)' : '[CONFIG] ⚠️ config issues';
  console.warn(header);
  for (const issue of all) console.warn(`  - ${issue.chain}: ${issue.message}`);
  if (isAutoExecute()) process.exit(1);
}

export function printStartupBanner(): string {
  console.log('----------------------------------------------------');
  console.log('Memeland autonomous multi-agent crypto system initializing...');
  console.log('----------------------------------------------------');
  const execMode = getExecutionMode();
  const chainsEnv = [...executableChainsFromEnv()];
  console.log(`[CONFIG] Memeland fork @ master=${process.env.MEMELAND_BUILD_SHA?.slice(0, 8) || 'local'}`);
  console.log(`         exec=${execMode} | dry_run=${isDryRunMode()} | auto_exec=${isAutoExecute()} | op_approval=${process.env.OPERATOR_APPROVAL_REQUIRED !== 'false'} | safety_gate=${process.env.SAFETY_GATE_ENFORCED === 'true'}`);
  console.log(`         execution_layer=LI.FI/Jumper (only) | chains=${chainsEnv.join('+')}`);
  console.log(`         autonomy_ladder=${isAutoExecute() ? 'Phase 3 AUTO (gated)' : isSignalOnly() ? 'Phase 1 SIGNAL_ONLY' : 'Phase 2 APPROVAL'}`);
  console.log('[SWARM] voters=9 (quant/ml/security/sentiment/whale/critic/wallet/convergence/rubric) | gate=swarm-consensus≥80% | floor=NEVER-LOWERED');
  console.log('[EXECUTION] lifi-executor (LI.FI/Jumper — only execution layer on this fork)');
  // Provider-role map: four-role model (introducer/emitter/enricher/regime/…)
  // derived from the SAME env gates the runtime reads — the Zeabur log reflects
  // the current provider fabric, not a stale snapshot.
  printProviderBanner();
  // Memeland fork multichain audit-key warning: every chain in MULTICHAIN_CHAINS that
  // doesn't have a GMGN_API_KEY_<CHAIN> (or a base GMGN_API_KEY) will cascade-fail
  // at the audit gate (Fix #5's "audit unavailable (likely 429/401)"). Surface this
  // loudly at boot so the operator sees it once, not in every cycle log line.
  const gmgnBase = !!process.env.GMGN_API_KEY;
  const perChainKey = (chain: string) => !!process.env[`GMGN_API_KEY_${chain.toUpperCase()}`];
  const unprovisioned = chainsEnv.filter((c) => !gmgnBase && !perChainKey(c));
  if (unprovisioned.length > 0) {
    console.warn(`[CONFIG] ⚠️  chains without a GMGN key: ${unprovisioned.join(', ')} — every audit on these will fail-closed. Set GMGN_API_KEY or GMGN_API_KEY_<CHAIN> in Zeabur env.`);
  }
  return execMode;
}
