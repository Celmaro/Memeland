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
  console.log(`[CONFIG] Memeland fork @ master=${process.env.MEMELAND_BUILD_SHA?.slice(0, 8) || 'local'}`);
  console.log(`         exec=${execMode} | dry_run=${isDryRunMode()} | auto_exec=${isAutoExecute()} | op_approval=${process.env.OPERATOR_APPROVAL_REQUIRED !== 'false'} | safety_gate=${process.env.SAFETY_GATE_ENFORCED === 'true'}`);
  console.log(`         execution_layer=LI.FI/Jumper (only) | chains=sol,bsc,base,eth,robinhood`);
  console.log(`         autonomy_ladder=${isAutoExecute() ? 'Phase 3 AUTO (gated)' : isSignalOnly() ? 'Phase 1 SIGNAL_ONLY' : 'Phase 2 APPROVAL'}`);
  // Memeland-fork kernel map. The 12-PR plan + KC1–KC9 consolidation + Kernels
  // S/T/U/V all landed here. See docs/KERNEL_CATALOG.md for the full surface.
  console.log('[KERNELS] A=reputation C=ledger D=sellability E=Result<T,E> F=decisionCache G=discovery | L=ttl-cache M=paced-http N=try-fetch-json O=staleness-clock P=chat-notifier Q=screening-runner R=wallet-balance');
  console.log('[SWARM] voters=10 (quant/ml/security/sentiment/whale/regime/critic/wallet/convergence/rubric) | gate=swarm-consensus≥80% | floor=NEVER-LOWERED');
  console.log('[EXECUTION] lifi-executor (LI.FI/Jumper — only execution layer on this fork)');
  return execMode;
}
