import { assertStartupConfig } from '../config/startup-validation.js';
import { getExecutionMode } from '../config/config.js';

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
  console.log('🐾 OPENCATZ MULTI-AGENT CRYPTO SYSTEM INITIALIZING...');
  console.log('----------------------------------------------------');
  const execMode = getExecutionMode();
  console.log(`[CONFIG] OpenCatz Execution Mode: ${execMode} (Primary Swap Venue: Uniswap V3 on Robinhood Chain #4663)`);
  return execMode;
}
