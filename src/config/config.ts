export type ExecutionMode = 'AUTO_EXECUTE' | 'DRY_RUN' | 'SIGNAL_ONLY';

/**
 * Canonical execution-mode resolution from an arbitrary env. `EXECUTION_MODE`
 * is authoritative; the legacy `AUTO_EXECUTE_ENABLED` and `DRY_RUN=false`
 * flags are treated as aliases so the runtime's execution admission and the
 * startup safety validator agree on ONE posture. Pure (injectable env) so both
 * `getExecutionMode()` and startup-validation consume the same truth.
 */
export function getExecutionModeFromEnv(env: NodeJS.ProcessEnv = process.env): ExecutionMode {
  const upper = env.EXECUTION_MODE?.trim().toUpperCase();
  if (upper === 'AUTO_EXECUTE' || upper === 'SIGNAL_ONLY' || upper === 'DRY_RUN') return upper;
  // Legacy aliases — only consulted when EXECUTION_MODE is absent/invalid.
  if (env.AUTO_EXECUTE_ENABLED === 'true' || env.AUTO_EXECUTE_ENABLED === '1') return 'AUTO_EXECUTE';
  if (env.DRY_RUN === 'false' || env.DRY_RUN === '0') return 'AUTO_EXECUTE';
  return 'DRY_RUN';
}

export function getExecutionMode(): ExecutionMode {
  return getExecutionModeFromEnv(process.env);
}

export function isDryRun(): boolean {
  const mode = getExecutionMode();
  return mode === 'DRY_RUN' || mode === 'SIGNAL_ONLY';
}

export function isSignalOnly(): boolean {
  return getExecutionMode() === 'SIGNAL_ONLY';
}

export function isAutoExecute(): boolean {
  return getExecutionMode() === 'AUTO_EXECUTE';
}

export function getEnvString(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value;
}

export function getApiKey(name: string): string | undefined {
  return getEnvString(name);
}

