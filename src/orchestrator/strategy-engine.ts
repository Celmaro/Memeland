import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync, spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import type { OpenCatStrategy, OpenCatIndicator } from './strategy-types.js';
import { withClearedEnv } from '../services/env-sandbox.js';
import { atomicWriteJsonSync } from '../storage/atomic-file-store.js';

const requireEsm = createRequire(import.meta.url);

const PROJECT_ROOT = path.resolve(process.cwd());
const DEFAULT_STRATEGIES_DIR = path.join(PROJECT_ROOT, 'strategies');
const DEFAULT_INDICATORS_DIR = path.join(PROJECT_ROOT, 'indicators');

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export class StrategyEngine {
  private readonly strategiesDir: string;
  private readonly indicatorsDir: string;
  private readonly strategiesBackupDir: string;
  private readonly indicatorsBackupDir: string;
  private readonly activeFile: string;
  // Vitest can run many child Node processes concurrently on Windows; the
  // Hermes Node runtime may abort in that nested environment. Production
  // still uses workers, while tests use the cleared-env fallback directly.
  private workerUsable = !process.env.VITEST && !process.argv.some((arg) => arg.includes('vitest'));

  /**
   * Baseline Windows env for spawning child Node processes.
   * worker restricts the env to block secret leakage (see `secretOnlyEnv`),
   * but `runStrategySafely` falls back to a baseline env when needed.
   */
  private baselineEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot','SystemDrive','WINDIR','ComSpec','PATHEXT','PATH','TEMP','TMP','USERPROFILE']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    return env;
  }

  /**
   * Hermetic override: tests can point the engine at temp dirs so write/
   * activation never touches the real repo strategies/. Defaults to the
   * canonical process.cwd()-based paths (backward compatible).
   */
  constructor(opts?: { strategiesDir?: string; indicatorsDir?: string }) {
    this.strategiesDir = opts?.strategiesDir || DEFAULT_STRATEGIES_DIR;
    this.indicatorsDir = opts?.indicatorsDir || DEFAULT_INDICATORS_DIR;
    this.strategiesBackupDir = path.join(this.strategiesDir, '.backup');
    this.indicatorsBackupDir = path.join(this.indicatorsDir, '.backup');
    this.activeFile = path.join(this.strategiesDir, '.active.json');
    this.ensureDirs();
  }

  private ensureDirs(): void {
    for (const dir of [this.strategiesDir, this.indicatorsDir, this.strategiesBackupDir, this.indicatorsBackupDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
  }

  // ─── Listing / reading ───────────────────────────────────────────────

  public listStrategies(): Array<{ id: string; active: boolean }> {
    this.ensureDirs();
    const activeMap = this.readActiveMap();
    const activeIds = Object.values(activeMap).filter((v): v is string => typeof v === 'string');
    const files = fs.existsSync(this.strategiesDir)
      ? fs.readdirSync(this.strategiesDir).filter((f) => f.endsWith('.mjs'))
      : [];
    return files.map((f) => {
      const id = f.replace(/\.mjs$/, '');
      return { id, active: activeIds.includes(id) || activeMap[id] === true };
    });
  }

  public readStrategy(name: string): { success: boolean; message: string; data?: { content: string } } {
    if (!SAFE_NAME_RE.test(name)) return { success: false, message: 'Invalid strategy name (use alphanumeric, dash, underscore).' };
    const file = path.join(this.strategiesDir, `${name}.mjs`);
    if (!fs.existsSync(file)) return { success: false, message: `Strategy ${name} not found.` };
    return { success: true, message: `Contents of strategy ${name}.`, data: { content: fs.readFileSync(file, 'utf-8') } };
  }

  // ─── Validation (subprocess import — reliable in dist & test envs) ───

  private validateModuleFile(filePath: string, kind: 'strategy' | 'indicator'): { ok: boolean; error?: string } {
    // In test environments the nested child Node aborts (CSPRNG); validate
    // in-process with the cleared-env import instead of burning a 20s timeout.
    if (!this.workerUsable) {
      try {
        const entry = this.importCached(filePath);
        const mod = entry.mod as any;
        if (typeof mod?.id !== 'string' || !mod.id) return { ok: false, error: 'module must export string id' };
        if (kind === 'strategy') {
          if (typeof mod?.evaluate !== 'function') return { ok: false, error: 'module must export { id, evaluate(ctx) }' };
        } else {
          if (typeof mod?.calculate !== 'function') return { ok: false, error: 'module must export { id, calculate(candles) }' };
        }
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message || 'validation failed' };
      }
    }
    const url = pathToFileURL(filePath).href;
    const script = `
      const url = process.argv[1];
      const kind = process.argv[2];
      import(url).then((m) => {
        const s = m.default || m;
        if (kind === 'strategy') {
          if (typeof s?.evaluate !== 'function') { console.error('INVALID: module must export { id, evaluate(ctx) }'); process.exit(1); }
          if (typeof s?.id !== 'string' || !s.id) { console.error('INVALID: module must export string id'); process.exit(1); }
        } else {
          if (typeof s?.calculate !== 'function') { console.error('INVALID: module must export { id, calculate(candles) }'); process.exit(1); }
          if (typeof s?.id !== 'string' || !s.id) { console.error('INVALID: module must export string id'); process.exit(1); }
        }
        console.error('VALID'); process.exit(0);
      }).catch((e) => { console.error('INVALID: ' + (e?.message || String(e))); process.exit(1); });
    `;
    try {
      const res = execFileSync(
        process.execPath,
        ['--input-type=module', '-e', script, url, kind],
        { timeout: 20000, encoding: 'utf-8', windowsHide: true, env: this.baselineEnv() }
      );
      return { ok: true };
    } catch (err: any) {
      const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : (err?.message || 'Validation failed.');
      return { ok: false, error: stderr };
    }
  }

  private loadModuleMetadata(filePath: string): Record<string, unknown> {
    // In test environments skip the nested child entirely; derive metadata
    // from the cleared-env in-process import.
    if (!this.workerUsable) {
      const entry = this.importCached(filePath);
      const mod = entry.mod as any;
      const kind: 'strategy' | 'indicator' = typeof mod?.evaluate === 'function' ? 'strategy' : 'indicator';
      if (!kind || typeof mod?.id !== 'string' || !mod.id) throw new Error('module has an invalid strategy/indicator shape');
      return { ok: true, kind, id: mod.id, name: mod.name, version: mod.version, description: mod.description, params: mod.params || {} };
    }
    const script = `
      const url = process.argv[1];
      const marker = '__OPENCATZ_RESULT__';
      (async () => {
        try {
          const mod = await import(url);
          const value = mod.default || mod;
          const kind = typeof value?.evaluate === 'function' ? 'strategy' : typeof value?.calculate === 'function' ? 'indicator' : null;
          if (!kind || typeof value?.id !== 'string' || !value.id) throw new Error('module has an invalid strategy/indicator shape');
          process.stdout.write(marker + JSON.stringify({ ok: true, kind, id: value.id, name: value.name, version: value.version, description: value.description, params: value.params || {} }));
        } catch (error) {
          process.stdout.write(marker + JSON.stringify({ ok: false, error: error?.message || String(error) }));
          process.exitCode = 1;
        }
      })();
    `;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, pathToFileURL(filePath).href],
      { env: this.baselineEnv(), timeout: 10000, maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true }
    );
    if (result.error) throw new Error(`module metadata worker error: ${result.error.message} (status=${result.status}, signal=${result.signal})`);
    if (result.signal) throw new Error(`module metadata worker terminated by ${result.signal}`);
    const marker = '__OPENCATZ_RESULT__';
    if (result.status !== 0 && !result.stdout.includes(marker)) {
      throw new Error(`module metadata worker failed (status=${result.status}, signal=${result.signal})`);
    }
    const output = result.stdout.slice(result.stdout.lastIndexOf(marker) + marker.length);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(output || '{}'); } catch { throw new Error('worker returned invalid module metadata'); }
    if (!parsed.ok) throw new Error(String(parsed.error || 'module metadata failed'));
    return parsed;
  }

  /**
   * Run a user-authored strategy/indicator call. Two-stage execution:
     * 1) Try an out-of-process worker (defense in depth — a malicious module
     *    cannot directly read process secrets from the parent).
     * 2) On worker-runtime failure (e.g. nested sandbox / CSPRNG abort under
     *    vitest forks on Windows), fall back to in-process empty-env execution
     *    via the legacy env sandbox so the bot never silently regresses.
     */
    private runModuleInWorker(filePath: string, kind: 'evaluate' | 'calculate', arg: unknown): unknown {
      if (!this.workerUsable) return this.runModuleInProcess(filePath, kind, arg);
      try {
        const out = this.runModuleInWorkerChild(filePath, kind, arg);
        return out;
      } catch (err: any) {
        const msg = String(err?.message || err);
        const isWorkerCrash = /status=(13\d|null)/.test(msg) || /EINVAL/.test(msg) || /CSPRNG/.test(msg);
        if (!isWorkerCrash) throw err;
        this.workerUsable = false;
        console.warn(`[STRATEGY ENGINE] worker unavailable (${msg.slice(0, 200)}) — falling back to in-process empty-env execution (and never retrying in this process).`);
        return this.runModuleInProcess(filePath, kind, arg);
      }
    }

  private runModuleInWorkerChild(filePath: string, kind: 'evaluate' | 'calculate', arg: unknown): unknown {
    const script = `
      import fs from 'node:fs';
      const url = process.argv[1];
      const kind = process.argv[2];
      const marker = '__OPENCATZ_RESULT__';
      (async () => {
        try {
          const mod = await import(url);
          const value = mod.default || mod;
          const fn = value?.[kind];
          if (typeof fn !== 'function') throw new Error('module does not export ' + kind);
          const input = fs.readFileSync(0, 'utf8');
          const output = fn.call(value, input ? JSON.parse(input) : undefined);
          process.stdout.write(marker + JSON.stringify({ ok: true, value: output === undefined ? null : output }));
        } catch (error) {
          process.stdout.write(marker + JSON.stringify({ ok: false, error: error?.message || String(error) }));
          process.exitCode = 1;
        }
      })();
    `;
    // The call body is untrusted but the *module import* already ran inside
    // the metadata worker (see loadModuleMetadata). Pass a baseline Windows
    // env so Node's crypto subsystem (CSPRNG) can initialise on nested forks.
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script, pathToFileURL(filePath).href, kind],
      {
        env: this.baselineEnv(),
        input: JSON.stringify(arg ?? null),
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      }
    );
    if (result.error) throw new Error(`strategy worker failed: ${result.error.message} (status=${result.status})`);
    if (result.signal) throw new Error(`strategy worker terminated by ${result.signal}`);
    const marker = '__OPENCATZ_RESULT__';
    if (result.status !== 0 && !result.stdout.includes(marker)) {
      throw new Error(`strategy worker exited unsuccessfully (status=${result.status})`);
    }
    const output = result.stdout.slice(result.stdout.lastIndexOf(marker) + marker.length);
    let parsed: { ok?: boolean; value?: unknown; error?: string };
    try { parsed = JSON.parse(output || '{}'); } catch { throw new Error('strategy worker returned invalid output'); }
    if (!parsed.ok) throw new Error(parsed.error || 'strategy worker rejected execution');
    return parsed.value;
  }

  /**
   * Legacy in-process fallback. The untrusted module is imported exactly
   * once with an empty env so its top-level code (and any side effects
   * like `import` statements that probe fs/process) never sees process
   * secrets; cached per filePath so we don't re-import on every call.
   */
  private importCache = new Map<string, { mod: unknown; kind: 'strategy' | 'indicator' }>();
    /** Import a module once with a cleared env and cache the entry. */
    private importCached(filePath: string): { mod: unknown; kind: 'strategy' | 'indicator' } {
      let entry = this.importCache.get(filePath);
      if (!entry) {
        entry = withClearedEnv(() => {
          const required = requireEsm(filePath);
          const mod = required?.default || required;
          const modKind: 'strategy' | 'indicator' = typeof mod?.evaluate === 'function' ? 'strategy' : 'indicator';
          return { mod, kind: modKind };
        });
        this.importCache.set(filePath, entry);
      }
      return entry;
    }
    private runModuleInProcess(filePath: string, kind: 'evaluate' | 'calculate', arg: unknown): unknown {
      const entry = this.importCached(filePath);
      const fn = (entry.mod as any)?.[kind];
      if (typeof fn !== 'function') throw new Error('module does not export ' + kind);
      return withClearedEnv(() => fn.call(entry.mod, arg ?? null));
    }

  // ─── Write (sandbox + backup + validate + rollback) ──────────────────

  public writeStrategy(name: string, code: string): { success: boolean; message: string } {
    return this.writeSandboxed(this.strategiesDir, this.strategiesBackupDir, name, code, 'strategy');
  }

  public writeIndicator(name: string, code: string): { success: boolean; message: string } {
    return this.writeSandboxed(this.indicatorsDir, this.indicatorsBackupDir, name, code, 'indicator');
  }

  private writeSandboxed(dir: string, backupDir: string, name: string, code: string, kind: 'strategy' | 'indicator'): { success: boolean; message: string } {
    this.ensureDirs();
    if (!SAFE_NAME_RE.test(name)) return { success: false, message: 'Invalid file name (alphanumeric, dash, underscore only).' };
    if (!code || !code.trim()) return { success: false, message: 'Empty code.' };

    const file = path.join(dir, `${name}.mjs`);
    const existed = fs.existsSync(file);

    // 1. Backup existing version
    if (existed) {
      const backupPath = path.join(backupDir, `${name}.mjs.bak`);
      try {
        fs.copyFileSync(file, backupPath);
      } catch (err: any) {
        return { success: false, message: `Failed to back up the previous version: ${err.message}` };
      }
    }

    // 2. Write new version
    try {
      fs.writeFileSync(file, code, 'utf-8');
    } catch (err: any) {
      return { success: false, message: `Failed to write file: ${err.message}` };
    }

    // 3. Validate (subprocess import + shape check)
    const validation = this.validateModuleFile(file, kind);
    if (!validation.ok) {
      // 4. Rollback on failure
      const backupPath = path.join(backupDir, `${name}.mjs.bak`);
      if (existed && fs.existsSync(backupPath)) {
        try { fs.copyFileSync(backupPath, file); } catch { /* ignore */ }
        return { success: false, message: `Validation failed: ${validation.error}. The previous version has been restored.` };
      }
      if (!existed) {
        try { fs.unlinkSync(file); } catch { /* ignore */ }
      }
      return { success: false, message: `Validation failed: ${validation.error}. The new file has been removed.` };
    }

    return { success: true, message: `✅ ${name} saved & validated successfully.${existed ? ' The previous version was backed up.' : ''}` };
  }

  public rollbackStrategy(name: string): { success: boolean; message: string } {
    return this.rollbackFile(this.strategiesDir, this.strategiesBackupDir, name);
  }

  private rollbackFile(dir: string, backupDir: string, name: string): { success: boolean; message: string } {
    if (!SAFE_NAME_RE.test(name)) return { success: false, message: 'Invalid file name.' };
    const backupPath = path.join(backupDir, `${name}.mjs.bak`);
    if (!fs.existsSync(backupPath)) return { success: false, message: `No backup for ${name}.` };
    try {
      fs.copyFileSync(backupPath, path.join(dir, `${name}.mjs`));
      return { success: true, message: `✅ ${name} rolled back to the backup version.` };
    } catch (err: any) {
      return { success: false, message: `Rollback failed: ${err.message}` };
    }
  }

  // ─── Active strategy per domain ──────────────────────────────────────

  private readActiveMap(): Record<string, string | boolean> {
    if (!fs.existsSync(this.activeFile)) return {};
    try {
      return JSON.parse(fs.readFileSync(this.activeFile, 'utf-8'));
    } catch {
      return {};
    }
  }

  private writeActiveMap(map: Record<string, string | boolean>): void {
    try {
      atomicWriteJsonSync(this.activeFile, map);
    } catch (err: any) {
      console.warn(`[STRATEGY ENGINE] Failed to persist the active map: ${err.message}`);
    }
  }

  private domainKey(domain: string): string {
    return domain.toLowerCase().replace(/[_\s]+/g, '-');
  }

  /**
   * Per-domain activation: each domain keeps its own active strategy, so
   * activating meme-robinhood does NOT deactivate nft or lp-robinhood.
   * Active map format: { [domainKey]: strategyId }.
   */
  public setActiveStrategy(domain: string, strategyId: string): { success: boolean; message: string } {
    const strategies = this.listStrategies();
    if (!strategies.some((s) => s.id === strategyId)) {
      return { success: false, message: `Strategy ${strategyId} not found in strategies/.` };
    }
    const map = this.readActiveMap();
    map[this.domainKey(domain)] = strategyId;
    this.writeActiveMap(map);
    return { success: true, message: `✅ Strategy ${strategyId} is now active for domain ${domain}.` };
  }

  public getActiveStrategy(domain: string): OpenCatStrategy | null {
    const map = this.readActiveMap();
    const domainKey = this.domainKey(domain);
    let activeId = typeof map[domainKey] === 'string' ? map[domainKey] : undefined;
    if (!activeId) {
      // Legacy format migration: { strategyId: true } global map from before per-domain activation.
      const legacy = Object.entries(map).find(([, v]) => v === true);
      activeId = legacy ? legacy[0] : undefined;
    }
    if (activeId) {
      const file = path.join(this.strategiesDir, `${activeId}.mjs`);
      if (fs.existsSync(file)) {
        try {
          const mod = this.loadModule(file);
          return mod.default || mod;
        } catch (err: any) {
          console.warn(`[STRATEGY ENGINE] Failed to load the active strategy ${activeId}: ${err.message}`);
        }
      }
    }
    // Fallback: domain-default strategy (e.g. meme-robinhood-default.mjs) is active
    // out-of-the-box when no explicit strategy has been set yet.
    const defaultId = `${this.domainKey(domain)}-default`;
    const defaultFile = path.join(this.strategiesDir, `${defaultId}.mjs`);
    if (fs.existsSync(defaultFile)) {
      try {
        const mod = this.loadModule(defaultFile);
        return mod.default || mod;
      } catch (err: any) {
        console.warn(`[STRATEGY ENGINE] Failed to load the default strategy ${defaultId}: ${err.message}`);
      }
    }
    return null;
  }

  public getIndicator(id: string): OpenCatIndicator | null {
    const file = path.join(this.indicatorsDir, `${id}.mjs`);
    if (!fs.existsSync(file)) return null;
    try {
      const mod = this.loadModule(file);
      return mod.default || mod;
    } catch (err: any) {
      console.warn(`[STRATEGY ENGINE] Failed to load indicator ${id}: ${err.message}`);
      return null;
    }
  }

  private loadModule(filePath: string): any {
    // Primary path: child-process worker (defense in depth). If the worker
    // runtime fails (CSPRNG abort in nested forks), the in-process fallback
    // inside runModuleInWorker takes over without losing functionality.
    const metadata = this.loadModuleMetadata(filePath);
    const proxy: Record<string, unknown> = { ...metadata };
    if (metadata.kind === 'strategy') {
      proxy.evaluate = (ctx: unknown) => this.runModuleInWorker(filePath, 'evaluate', ctx);
    }
    if (metadata.kind === 'indicator') {
      proxy.calculate = (candles: unknown) => this.runModuleInWorker(filePath, 'calculate', candles);
    }
    return proxy;
  }

  /**
   * Execute a strategy/indicator call. File-backed modules are worker proxies
   * with an automatic in-process fallback; injected test doubles remain
   * supported with the legacy empty-env guard.
   */
  public runStrategySafely<T extends { evaluate?: (ctx: any) => any; calculate?: (candles: any[]) => any[] }>(
    strategy: T,
    kind: 'evaluate' | 'calculate',
    arg: any
  ): any {
    const fn = kind === 'evaluate' ? strategy?.evaluate : strategy?.calculate;
    if (typeof fn !== 'function') return undefined;
    return withClearedEnv(() => {
      return fn.call(strategy, arg);
    });
  }
}
