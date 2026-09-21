export interface StartupConfigError {
  key: string;
  message: string;
}

export interface StartupConfigResult {
  ok: boolean;
  errors: StartupConfigError[];
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function finiteNumber(env: NodeJS.ProcessEnv, key: string, min: number, max: number, errors: StartupConfigError[]): void {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    errors.push({ key, message: `must be a number between ${min} and ${max}` });
  }
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** Pure, centralized validation for settings that can change startup safety. */
export function validateStartupConfig(env: NodeJS.ProcessEnv = process.env): StartupConfigResult {
  const errors: StartupConfigError[] = [];
  const dryRun = bool(env.DRY_RUN);
  const autoExecute = bool(env.AUTO_EXECUTE_ENABLED);
  const operatorApproval = bool(env.OPERATOR_APPROVAL_REQUIRED);

  for (const [key, min, max] of [
    ['API_PORT', 1, 65535],
    ['SCREENING_TIMEOUT_MS', 1000, 3600000],
    ['COST_CAP_USD', 0, 100000000],
  ] as const) finiteNumber(env, key, min, max, errors);

  if (env.DRY_RUN !== undefined && dryRun === undefined) errors.push({ key: 'DRY_RUN', message: 'must be true/false or 1/0' });
  if (env.AUTO_EXECUTE_ENABLED !== undefined && autoExecute === undefined) errors.push({ key: 'AUTO_EXECUTE_ENABLED', message: 'must be true/false or 1/0' });
  if (env.OPERATOR_APPROVAL_REQUIRED !== undefined && operatorApproval === undefined) errors.push({ key: 'OPERATOR_APPROVAL_REQUIRED', message: 'must be true/false or 1/0' });

  const liveAuto = dryRun === false && autoExecute === true;
  if (liveAuto) {
    if (!(env.LIVE_TRADING_ACKNOWLEDGED === 'true' || env.LIVE_TRADING_ACKNOWLEDGED === '1')) {
      errors.push({ key: 'LIVE_TRADING_ACKNOWLEDGED', message: 'must be explicitly enabled for live auto-execution' });
    }
    if (operatorApproval === false) {
      errors.push({ key: 'OPERATOR_APPROVAL_REQUIRED', message: 'cannot be false for live auto-execution' });
    }
    if (!env.EVM_PRIVATE_KEY?.trim()) errors.push({ key: 'EVM_PRIVATE_KEY', message: 'is required for live auto-execution' });
  }

  const host = env.API_BIND_HOST || '127.0.0.1';
  if (!isLoopback(host) && !(env.OPENCATZ_API_KEY || env.OPENCAT_API_KEY)?.trim()) {
    errors.push({ key: 'OPENCATZ_API_KEY', message: 'is required when API_BIND_HOST is non-loopback' });
  }
  if (env.API_ALLOWED_ORIGINS?.split(',').some((origin) => !origin.trim())) {
    errors.push({ key: 'API_ALLOWED_ORIGINS', message: 'cannot contain empty origins' });
  }

  return { ok: errors.length === 0, errors };
}

export function assertStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const result = validateStartupConfig(env);
  if (!result.ok) {
    const message = result.errors.map((e) => `${e.key}: ${e.message}`).join('; ');
    throw new Error(`Invalid startup configuration: ${message}`);
  }
}
