import { assertStartupConfig } from '../config/startup-validation.js';
import { getExecutionMode, isDryRun as isDryRunMode, isAutoExecute, isSignalOnly } from '../config/config.js';

/** Central startup guard: same env checks as before, packaged as a boot module. */
export function bootstrapStartupConfig(): void {
  try {
    assertStartupConfig();
  } catch (err: any) {
    console.error(`[CONFIG] REFUSING TO START: ${err.message}`);
    process.exit(1);
  }
}

export function printStartupBanner(): string {
  console.log('----------------------------------------------------');
  console.log('Memeland autonomous multi-agent crypto system initializing...');
  console.log('----------------------------------------------------');
  const execMode = getExecutionMode();
  const chainsEnv = (process.env.MULTICHAIN_CHAINS || 'sol,bsc,base,eth,robinhood')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  console.log(`[CONFIG] Memeland fork @ master=${process.env.MEMELAND_BUILD_SHA?.slice(0, 8) || 'local'}`);
  console.log(`         exec=${execMode} | dry_run=${isDryRunMode()} | auto_exec=${isAutoExecute()} | op_approval=${process.env.OPERATOR_APPROVAL_REQUIRED !== 'false'} | safety_gate=${process.env.SAFETY_GATE_ENFORCED === 'true'}`);
  console.log(`         execution_layer=LI.FI/Jumper (only) | chains=${chainsEnv.join('+')}`);
  console.log(`         autonomy_ladder=${isAutoExecute() ? 'Phase 3 AUTO (gated)' : isSignalOnly() ? 'Phase 1 SIGNAL_ONLY' : 'Phase 2 APPROVAL'}`);
  // Memeland-fork kernel map. The 12-PR plan + KC1–KC9 consolidation + Kernels
  // S/T/U/V all landed here. See docs/KERNEL_CATALOG.md for the full surface.
  console.log('[KERNELS] A=reputation C=ledger D=sellability E=Result<T,E> F=decisionCache G=discovery | L=ttl-cache M=paced-http N=try-fetch-json O=staleness-clock P=chat-notifier Q=screening-runner R=wallet-balance');
  console.log('[SWARM] voters=10 (quant/ml/security/sentiment/whale/regime/critic/wallet/convergence/rubric) | gate=swarm-consensus≥80% | floor=NEVER-LOWERED');
  console.log('[EXECUTION] lifi-executor (LI.FI/Jumper — only execution layer on this fork)');
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
