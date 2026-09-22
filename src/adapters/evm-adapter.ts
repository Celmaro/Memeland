import type { WalletService } from '../services/wallet-service.js';
import { isDryRun as isDryRunMode } from '../config/config.js';
import { fetchWithKeyPool, loadApiKeyPool, type ApiKeyPool } from '../services/api-key-pool.js';
import { clampSize, type AdapterError, type Result } from './result.js';
import { resolveExecutionChain } from '../config/execution-registry.js';

export interface EVMTradeRequest {
  chain: string;
  tokenAddress: string;
  amountEth: number;
  slippagePercentage?: number; // e.g. 1.5%
}

export interface EVMTradeResult {
  success: boolean;
  txHash?: string;
  explorerUrl?: string;
  chain: string;
  inputEth: number;
  outputTokens: number;
  dexUsed: string;
  simulated: boolean;
  error?: string;
}

export interface EVMSendRequest {
  chain: string | number;
  recipientAddress: string;
  amountEth: number;
}

export interface EVMSwapRequest {
  chain: string | number;
  fromToken: string;
  toToken: string;
  amountEth: number;
}

export class EVMTradeAdapter {
  private isDryRun: boolean;
  private uniswapKeyPool: ApiKeyPool = loadApiKeyPool('UNISWAP_API_KEY');

  constructor() {
    this.isDryRun = isDryRunMode();
  }

  public parseChainId(chainInput: string | number): number {
    return resolveExecutionChain(String(chainInput)).lifiChainId;
  }

  public async executeBuyToken(request: EVMTradeRequest, _walletService?: WalletService): Promise<EVMTradeResult> {
    const dexName = 'Uniswap API (Robinhood L2)';

    console.log(`[EVM ADAPTER] Initiating Buy Order on ${String(request.chain).toUpperCase()} via ${dexName} (Amount: ${request.amountEth} ETH)`);

    if (this.isDryRun) {
      // Realistic dry run: fetch REAL quote from the Uniswap API, report real numbers, do NOT broadcast.
      console.log(`[EVM ADAPTER] DRY_RUN=true -> Fetching REAL Uniswap API quote (no broadcast)...`);

      // Fail closed: entry is not usable without a quote API key.
      if (this.uniswapKeyPool.size === 0) {
        console.warn('UNISWAP_API_KEY missing — cannot fetch real quote. Set UNISWAP_API_KEY in .env (dry-run stays simulated).');
        return {
          success: false,
          chain: String(request.chain),
          inputEth: request.amountEth,
          outputTokens: 0,
          dexUsed: dexName,
          simulated: true,
          error: 'UNISWAP_API_KEY missing — cannot fetch real quote. Set UNISWAP_API_KEY in .env (dry-run stays simulated).',
        };
      }

      const quoteBody = {
        tokenIn: '0x0000000000000000000000000000000000000000', // native ETH
        tokenOut: request.tokenAddress,
        amount: BigInt(Math.round(request.amountEth * 1e18)).toString(),
        type: 'EXACT_INPUT',
        chainId: this.parseChainId(request.chain),
        configs: [{ protocols: ['V2','V3','V4'], routingType: 'CLASSIC', enableUniversalRouter: true }],
      };

      const quoteRes = await fetchWithKeyPool(
        this.uniswapKeyPool,
        async (key) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          try {
            return await fetch('https://trade-api.gateway.uniswap.org/v1/quote', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-api-key': key, 'accept': 'application/json' },
              body: JSON.stringify(quoteBody),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }
        },
        { label: '[EVM ADAPTER]', retryStatuses: [401, 403, 429] }
      );

      if (!quoteRes || !quoteRes.ok) {
        const errText = quoteRes ? await quoteRes.text().catch(() => '') : 'Network error';
        return { success: false, chain: String(request.chain), inputEth: request.amountEth, outputTokens: 0, dexUsed: dexName, simulated: true, error: `Uniswap API Quote Failed: ${errText}` };
      }
      const quote = (await quoteRes.json()) as Record<string, unknown>;
      return {
        success: true,
        txHash: `sim_evm_${request.chain}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        chain: String(request.chain),
        inputEth: request.amountEth,
        outputTokens: Number(quote.amountOut || 0) / 1e18,
        dexUsed: 'Uniswap API (Robinhood L2)',
        simulated: true,
      };
    }

    try {
      // Live execution now routes exclusively through the LI.FI executor
      // (lifi-executor.ts). The raw EVM adapter no longer quotes/broadcasts via
      // Relay — fail closed here so nothing bypasses the LI.FI-only layer.
      return {
        success: false,
        chain: String(request.chain),
        inputEth: request.amountEth,
        outputTokens: 0,
        dexUsed: dexName,
        simulated: false,
        error: 'live EVM execution now routes through the LI.FI executor — raw EVM adapter buy disabled (fail-closed)',
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[EVM ADAPTER LIVE BUY ERROR]', errMsg);
      return {
        success: false,
        chain: String(request.chain),
        inputEth: request.amountEth,
        outputTokens: 0,
        dexUsed: dexName,
        simulated: false,
        error: errMsg,
      };
    }
  }

  /**
   * Send native ETH directly via WalletService (viem)
   */
  public async sendToken(request: EVMSendRequest, walletService?: WalletService): Promise<EVMTradeResult> {
    const chainId = this.parseChainId(request.chain);
    console.log(`[EVM ADAPTER] Direct Send: ${request.amountEth} native token to ${request.recipientAddress} on Chain #${chainId}`);

    if (this.isDryRun) {
      const simHash = `0xsim_evm_send_${chainId}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      return {
        success: true,
        txHash: simHash,
        explorerUrl: walletService ? walletService.getExplorerUrl(chainId, simHash) : `https://robinhoodchain.blockscout.com/tx/${simHash}`,
        chain: String(request.chain),
        inputEth: request.amountEth,
        outputTokens: request.amountEth,
        dexUsed: 'Direct Native Transfer',
        simulated: true,
      };
    }

    try {
      if (!walletService || !walletService.hasWallet('evm')) {
        throw new Error('EVM wallet not configured. Use /wallet setup or set EVM_PRIVATE_KEY in .env');
      }

      const result = await walletService.sendEvm(chainId, request.recipientAddress, request.amountEth);
      return {
        success: true,
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        chain: String(request.chain),
        inputEth: request.amountEth,
        outputTokens: request.amountEth,
        dexUsed: 'Direct Native Transfer',
        simulated: false,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[EVM ADAPTER SEND ERROR]', errMsg);
      return {
        success: false,
        chain: String(request.chain),
        inputEth: request.amountEth,
        outputTokens: 0,
        dexUsed: 'Direct Native Transfer',
        simulated: false,
        error: errMsg,
      };
    }
  }

  /**
   * Swap tokens on EVM (simulated only — live swaps route through the LI.FI executor)
   */
  public async swapToken(request: EVMSwapRequest, walletService?: WalletService): Promise<EVMTradeResult> {
    const chainId = this.parseChainId(request.chain);
    console.log(`[EVM ADAPTER] Direct Swap: ${request.amountEth} ${request.fromToken} -> ${request.toToken} on Chain #${chainId}`);

    if (this.isDryRun) {
      const simHash = `0xsim_evm_swap_${chainId}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      return {
        success: true,
        txHash: simHash,
        explorerUrl: walletService ? walletService.getExplorerUrl(chainId, simHash) : `https://robinhoodchain.blockscout.com/tx/${simHash}`,
        chain: String(request.chain),
        inputEth: request.amountEth,
        outputTokens: request.amountEth * 3200, // Simulated output e.g. ETH -> USDC
        dexUsed: 'LI.FI / Jumper (simulated)',
        simulated: true,
      };
    }

    try {
      if (!walletService || !walletService.hasWallet('evm')) {
        throw new Error('EVM wallet not configured. Use /wallet setup or set EVM_PRIVATE_KEY in .env');
      }

      // Live swaps now route exclusively through the LI.FI executor
      // (lifi-executor.ts). The raw EVM adapter no longer quotes/broadcasts via
      // Relay — fail closed here so nothing bypasses the LI.FI-only layer.
      return {
        success: false,
        chain: String(request.chain),
        inputEth: request.amountEth,
        outputTokens: 0,
        dexUsed: 'LI.FI / Jumper (disabled on raw EVM adapter)',
        simulated: false,
        error: 'live EVM swap now routes through the LI.FI executor — raw EVM adapter swap disabled (fail-closed)',
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[EVM ADAPTER SWAP ERROR]', errMsg);
      return {
        success: false,
        chain: String(request.chain),
        inputEth: request.amountEth,
        outputTokens: 0,
        dexUsed: 'LI.FI / Jumper (disabled on raw EVM adapter)',
        simulated: false,
        error: errMsg,
      };
    }
  }
}

/**
 * PR 2 / Kernel E — two-lane RPC adapter (SRC-037 RABIQ read/submit lanes +
 * `logsSplit`, SRC-055 Stampede portable failover + rotation weighting +
 * per-host latency/error, SRC-039 PELLET throw-free `Result<T,E>`).
 *
 * Additive to `EVMTradeAdapter` (the high-level buy path above stays untouched).
  * Read ops (`call`/`getLogs`) and submit ops (`sendRawTx`) draw from independent
  * leaky-bucket lanes so a surge of reads never starves submissions. Failover is
  * weighted by host + penalized by errors, and failed hosts enter a cooldown.
  * PR 2 / Week 3 (G2 deprecation complete): the `callLegacy` throw-shim is
  * removed — callers consume `Result<Bytes, AdapterError>` directly via `call()`
  * (see `quoter-call-adapter.ts` for the first production caller).
  */

export type Bytes = string;
export type TxHash = string;

export interface Log {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
}

export interface EvmCallRequest {
  to: string;
  data: string;
  chain: string | number;
  block?: string;
}

export interface LogRequest {
  address: string;
  topics: string[];
  fromBlock: string | number;
  toBlock?: string;
  chain: string | number;
}

export interface SignedTx {
  chain: string | number;
  raw: string;
}

export interface RpcHost {
  url: string;
  rotationWeight?: number;
}

export interface HostHealth {
  host: string;
  latencyMs: number;
  errors: number;
  cooldownMs: number;
}

export interface RpcTransport {
  request(host: string, method: string, params: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

export interface EvmAdapterOptions {
  hosts: RpcHost[];
  transport?: RpcTransport;
  now?: () => number;
  cooldownMs?: number;
  laneTokensPerSec?: number;
  readLaneCapacity?: number;
  submitLaneCapacity?: number;
}

interface HostState {
  url: string;
  weight: number;
  latencyMs: number;
  errors: number;
  cooldownUntil: number;
}

/** Leaky-bucket token lane — one per RPC lane (read vs submit). */
class Lane {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number
  ) {
    this.tokens = capacity;
    this.lastRefill = now();
  }

  public tryTake(): boolean {
    const t = this.now();
    const dt = (t - this.lastRefill) / 1000;
    if (dt > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
      this.lastRefill = t;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/** Minimal JSON-RPC transport over global fetch; injectable for tests. */
class DefaultTransport implements RpcTransport {
  async request(host: string, method: string, params: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    try {
      const res = await fetch(host, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as { error?: { message?: string } | string; result?: unknown };
      if (body.error) {
        const message = typeof body.error === 'string' ? body.error : body.error?.message;
        return { ok: false, error: message ?? 'json-rpc error' };
      }
      return { ok: true, result: body.result };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export class EvmAdapter {
  private readonly now: () => number;
  private readonly transport: RpcTransport;
  private readonly cooldownMs: number;
  private readonly hosts: HostState[];
  private readonly readLane: Lane;
  private readonly submitLane: Lane;

  constructor(opts: EvmAdapterOptions) {
    this.now = opts.now ?? Date.now;
    this.transport = opts.transport ?? new DefaultTransport();
    this.cooldownMs = opts.cooldownMs ?? 0;
    const cap = opts.laneTokensPerSec ?? 4;
    this.readLane = new Lane(opts.readLaneCapacity ?? cap, cap, this.now);
    this.submitLane = new Lane(opts.submitLaneCapacity ?? cap, cap, this.now);
    this.hosts = opts.hosts.map((h) => ({
      url: h.url,
      weight: h.rotationWeight ?? 1,
      latencyMs: 0,
      errors: 0,
      cooldownUntil: 0,
    }));
  }

  private pickHost(): HostState | null {
    const now = this.now();
    const healthy = this.hosts.filter((h) => h.cooldownUntil <= now);
    if (healthy.length === 0) return null;
    let best: HostState | null = null;
    let bestScore = -1;
    for (const h of healthy) {
      const score = h.weight / (h.errors + 1);
      if (score > bestScore) {
        bestScore = score;
        best = h;
      }
    }
    return best;
  }

  private async dispatch(method: string, params: unknown[]): Promise<Result<unknown, AdapterError>> {
    const host = this.pickHost();
    if (!host) return { ok: false, error: { code: 'NO_HOST', message: 'all RPC hosts in cooldown', retryable: true } };
    const started = this.now();
    const res = await this.transport.request(host.url, method, params);
    host.latencyMs = this.now() - started;
    if (res.ok) return { ok: true, value: res.result };
    host.errors += 1;
    if (this.cooldownMs > 0) host.cooldownUntil = this.now() + this.cooldownMs;
    return { ok: false, error: { code: 'RPC_ERROR', message: res.error ?? 'rpc failed', retryable: true, host: host.url } };
  }

  /** Read-only lane: constant-call. Throttled independently of submissions. */
  public async call(req: EvmCallRequest): Promise<Result<Bytes, AdapterError>> {
    if (!this.readLane.tryTake()) {
      return { ok: false, error: { code: 'RATE_LIMIT', message: 'read lane throttled', retryable: true } };
    }
    const r = await this.dispatch('eth_call', [{ to: req.to, data: req.data }, typeof req.block === 'string' ? req.block : 'latest']);
    if (!r.ok) return r;
    return { ok: true, value: r.value as Bytes };
  }

  /** Read-only lane: log filter. */
  public async getLogs(req: LogRequest): Promise<Result<Log[], AdapterError>> {
    if (!this.readLane.tryTake()) {
      return { ok: false, error: { code: 'RATE_LIMIT', message: 'read lane throttled', retryable: true } };
    }
    const r = await this.dispatch('eth_getLogs', [
      { address: req.address, topics: req.topics, fromBlock: req.fromBlock, toBlock: req.toBlock ?? 'latest' },
    ]);
    if (!r.ok) return r;
    return { ok: true, value: r.value as Log[] };
  }

  /** Submit lane: broadcast. Independent 429/rate budget from reads. */
  public async sendRawTx(req: SignedTx): Promise<Result<TxHash, AdapterError>> {
    if (!this.submitLane.tryTake()) {
      return { ok: false, error: { code: 'RATE_LIMIT', message: 'submit lane throttled', retryable: true } };
    }
    const r = await this.dispatch('eth_sendRawTransaction', [req.raw]);
    if (!r.ok) return r;
    return { ok: true, value: r.value as TxHash };
  }

  public getHealth(): HostHealth[] {
    return this.hosts.map((h) => ({
      host: h.url,
      latencyMs: h.latencyMs,
      errors: h.errors,
      cooldownMs: Math.max(0, h.cooldownUntil - this.now()),
    }));
  }

  /** FLYWHEEL fail-safe: clamp a model-returned size to its cap before trusting it. */
  public overrideSize(rawSize: number, maxSize: number): Result<number, AdapterError> {
    return clampSize(rawSize, maxSize);
  }
}
