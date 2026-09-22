/**
 * LI.FI / Jumper execution adapter — the ONLY execution layer for every filled
 * trade on every configured chain.
 *
 * Implements the widened Q09 seam (`submit`) plus the manual `/swap` and
 * `/send` paths previously served by Relay. Flow:
 *
 *   1. POST /v1/quote             -> pick a route
 *   2. POST /v1/build-transaction -> concrete signable transaction
 *   3. sign + broadcast           -> viem (EVM) or @solana/web3.js (Solana)
 *   4. poll /v1/status            -> DONE / FAILED / timeout reconcile
 *
 * Behavior guarantees:
 *   - DRY_RUN fetches a REAL quote and build-transaction but never broadcasts,
 *     returning a `simulated` outcome.
 *   - A global pacing queue (same pattern as GMGN) avoids LI.FI 429 bursts.
 *   - Nonce idempotency: the same execution nonce is never broadcast twice and
 *     a `timed_out` fill is reconciled via /v1/status before any retry.
 *   - Unknown chains / tokens fail closed — no silent chain-id default.
 */
import { createWalletClient, http, type Account, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import base58 from 'bs58';
import fs from 'fs';
import path from 'path';
import { mainnet, bsc, base as baseChain, robinhood as robinhoodChain } from 'viem/chains';
import { isDryRun as isDryRunMode } from '../config/config.js';
import { tryFetchJson } from '../io/try-fetch-json.js';
import {
  explorerUrlForChain,
  normalizeExecutionChainKey,
  resolveExecutionChain,
  resolveFundingToken,
  type ExecutionChainKey,
} from '../config/execution-registry.js';

const LIFI_API_BASE = 'https://li.quest/v1';
const DEFAULT_INTEGRATOR = 'memeland';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/**
 * Default path for the persistent broadcast-nonce store (R3).
 * Overridable via `LIFI_NONCE_STORE_PATH`; absent in tests (use an explicit
 * in-memory store via the constructor) — the production executor writes here
 * so a process restart can detect that an in-flight nonce was already
 * broadcast and refuses to double-broadcast.
 */
const DEFAULT_NONCE_STORE_PATH = process.env.LIFI_NONCE_STORE_PATH || path.resolve(process.cwd(), 'database', 'lifi-broadcast-nonces.json');

export type LifiOutcome = 'confirmed' | 'failed' | 'timed_out' | 'simulated';

export interface LifiSubmitRequest {
  chain: string;
  token: string;
  side: 'buy' | 'sell';
  amountUsd: number;
  timeoutMs?: number;
}

export interface LifiFillResult {
  outcome: LifiOutcome;
  simulated?: boolean;
  txHash?: string;
  explorerUrl?: string;
  reason?: string;
  at: number;
}

export interface LifiSwapRequest {
  chain: string;
  fromToken: string;
  toToken: string;
  amount: number;
}

export interface LifiSendRequest {
  chain: string;
  token: string;
  amount: number;
  recipientAddress: string;
}

/** Minimal wallet surface the executor needs to sign/broadcast. */
export interface LifiWallet {
  getEvmAccount(): Account;
  sendSolana?(to: string, lamports: number): Promise<string>;
}

export interface LifiExecutorOptions {
  fetchImpl?: typeof fetch;
  wallet?: LifiWallet;
  evmPrivateKey?: string;
  solanaPrivateKey?: string;
  integrator?: string;
  requestSpacingMs?: number;
  executionTimeoutMs?: number;
  /** R9: override /quote slippage (fraction). Falls back to LIFI_SLIPPAGE_PCT. */
  slippage?: number;
  dryRun?: boolean;
  now?: () => number;
  /** R3: load previously-broadcast nonces from a JSON file path so a
   *  process restart can refuse to double-broadcast. Defaults to
   *  `${cwd}/database/lifi-broadcast-nonces.json`; pass an empty string to
   *  disable persistence. */
  nonceStorePath?: string;
}

/** Persistent record of an in-flight or settled broadcast nonce. */
export interface BroadcastNonceRecord {
  nonce: string;
  /** ISO timestamp the nonce was first added. */
  at: string;
  /** Latest known terminal state — undefined while in-flight. */
  outcome?: 'confirmed' | 'failed' | 'timed_out' | 'simulated';
  txHash?: string;
}

interface QuoteRoute {
  id?: string;
  fromAmount?: string;
  toAmount?: string;
  transactionRequest?: unknown;
}

const EVM_CHAIN_IDS: Record<Exclude<ExecutionChainKey, 'sol'>, Chain> = {
  eth: mainnet,
  bsc,
  base: baseChain,
  robinhood: robinhoodChain,
};

const EVM_RPC: Record<ExecutionChainKey, string> = {
  eth: process.env.EVM_ETH_RPC_URL || 'https://ethereum-rpc.publicnode.com',
  bsc: process.env.EVM_BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
  base: process.env.EVM_BASE_RPC_URL || 'https://mainnet.base.org',
  robinhood: process.env.EVM_ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  sol: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
};

const NATIVE_TOKEN_META: Record<string, { address: string; decimals: number }> = {
  ETH: { address: ZERO_ADDRESS, decimals: 18 },
  BNB: { address: ZERO_ADDRESS, decimals: 18 },
  SOL: { address: '11111111111111111111111111111111', decimals: 9 },
};

/**
 * Global pacing queue — all LI.FI requests (every adapter instance) queue here
 * with minimal spacing so bursts spread out and do not 429 the API.
 */
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

export class LifiExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly wallet?: LifiWallet;
  private readonly evmPrivateKey?: string;
  private readonly solanaPrivateKey?: string;
  private readonly integrator: string;
  private readonly requestSpacingMs: number;
  /** LI.FI /quote slippage as a fraction (0.005–0.05). Defaults to 0.02 (R9). */
  private readonly slippage: number;
  private readonly executionTimeoutMs: number;
  private readonly now: () => number;
  private readonly isDryRun: boolean;
  /** Nonces that were already broadcast — never broadcast the same nonce twice. */
  private readonly broadcastNonces = new Set<string>();
  /** Persistent mirror of `broadcastNonces` (R3): survives restarts, atomic write. */
  private readonly broadcastRecords = new Map<string, BroadcastNonceRecord>();
  private readonly nonceStorePath: string;
  /**
   * Per-chain EVM private-key override (R2): `EVM_PRIVATE_KEY_<CHAIN>` wins over
   * the shared `EVM_PRIVATE_KEY` so operators can segregate trading keys per
   * chain. Lookup is performed at broadcast time so a fresh key rotation
   * (env reload) is picked up without restarting the executor.
   */
  private evmPrivateKeyForChain(chainKey: ExecutionChainKey): string | undefined {
    const override = process.env[`EVM_PRIVATE_KEY_${chainKey.toUpperCase()}`];
    if (override?.trim()) return override;
    return this.evmPrivateKey;
  }

  constructor(opts: LifiExecutorOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wallet = opts.wallet;
    this.evmPrivateKey = opts.evmPrivateKey ?? process.env.EVM_PRIVATE_KEY;
    this.solanaPrivateKey = opts.solanaPrivateKey ?? process.env.SOLANA_PRIVATE_KEY;
    this.integrator = opts.integrator ?? process.env.LIFI_INTEGRATOR ?? DEFAULT_INTEGRATOR;
    this.requestSpacingMs = Math.max(100, Number(opts.requestSpacingMs ?? process.env.LIFI_REQUEST_SPACING_MS ?? 300));
    this.slippage = (() => {
      const raw = opts.slippage ?? process.env.LIFI_SLIPPAGE_PCT;
      if (raw === undefined) return 0.02;
      const n = Number(raw);
      if (!Number.isFinite(n)) return 0.02;
      // Allow "2" (=2%) or "0.02" (=2%) — normalise by /100 when > 1.
      const frac = n > 1 ? n / 100 : n;
      return Math.min(0.5, Math.max(0, frac));
    })();
    this.executionTimeoutMs = Number(opts.executionTimeoutMs ?? process.env.LIFI_EXECUTION_TIMEOUT_MS ?? 60_000);
    this.now = opts.now ?? Date.now;
    this.isDryRun = opts.dryRun ?? isDryRunMode();
    // R3: load the persisted nonce store from disk and hydrate both the Set
    // (in-process fast path) and the Map (carries outcome + txHash across
    // restarts). An empty-string path disables persistence.
    this.nonceStorePath = opts.nonceStorePath !== undefined ? opts.nonceStorePath : DEFAULT_NONCE_STORE_PATH;
    this.loadBroadcastStore();
  }

  private loadBroadcastStore(): void {
    if (!this.nonceStorePath) return;
    try {
      if (!fs.existsSync(this.nonceStorePath)) return;
      const raw = fs.readFileSync(this.nonceStorePath, 'utf-8');
      const records = JSON.parse(raw) as BroadcastNonceRecord[];
      for (const r of records) {
        this.broadcastNonces.add(r.nonce);
        this.broadcastRecords.set(r.nonce, r);
      }
    } catch (err: unknown) {
      console.warn(`[LIFI] nonce store load failed (${err instanceof Error ? err.message : String(err)}) — starting with empty store`);
    }
  }

  private persistBroadcastStore(): void {
    if (!this.nonceStorePath) return;
    try {
      fs.mkdirSync(path.dirname(this.nonceStorePath), { recursive: true });
      const records = Array.from(this.broadcastRecords.values());
      // Atomic write: tmp + rename so a crash mid-write never truncates.
      const tmp = `${this.nonceStorePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf-8');
      fs.renameSync(tmp, this.nonceStorePath);
    } catch (err: unknown) {
      console.warn(`[LIFI] nonce store persist failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** R3: expose the persistent record so callers can correlate txHash after restart. */
  public getBroadcastRecord(nonce: string): BroadcastNonceRecord | undefined {
    return this.broadcastRecords.get(nonce);
  }

  /**
   * R3: record a broadcast attempt (called by broadcastEVM / broadcastSolana).
   * Persists immediately so a process crash before settlement still has the
   * nonce on disk.
   */
  private recordBroadcast(nonce: string, partial: Partial<BroadcastNonceRecord> = {}): void {
    const existing = this.broadcastRecords.get(nonce);
    const record: BroadcastNonceRecord = {
      nonce,
      at: existing?.at || new Date().toISOString(),
      outcome: partial.outcome ?? existing?.outcome,
      txHash: partial.txHash ?? existing?.txHash,
    };
    this.broadcastRecords.set(nonce, record);
    this.persistBroadcastStore();
  }

  private async paced<T>(fn: () => Promise<T>): Promise<T> {
    const prev = requestQueue;
    let release!: () => void;
    requestQueue = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      const wait = Math.max(0, lastRequestAt + this.requestSpacingMs - this.now());
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastRequestAt = this.now();
      return await fn();
    } finally {
      release();
    }
  }

  private async lifiPost<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
      return tryFetchJson<T>(`${LIFI_API_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, {
        fetchImpl: this.fetchImpl,
        logger: (msg) => console.warn(msg),
        includeErrorBody: true,
      });
    }

    private async lifiGet<T>(path: string): Promise<T | null> {
      return tryFetchJson<T>(`${LIFI_API_BASE}${path}`, undefined, {
        fetchImpl: this.fetchImpl,
        logger: (msg) => console.warn(msg),
      });
    }

  private async quoteRoute(params: {
    fromChain: number;
    toChain: number;
    fromToken: string;
    toToken: string;
    fromAmount: string;
    fromAddress: string;
    toAddress: string;
  }): Promise<{ route: QuoteRoute; id?: string } | null> {
    return this.paced(async () => {
      const body = {
        fromChain: params.fromChain,
        toChain: params.toChain,
        fromToken: params.fromToken,
        toToken: params.toToken,
        fromAmount: params.fromAmount,
        fromAddress: params.fromAddress,
        toAddress: params.toAddress,
        slippage: this.slippage,
        integrator: this.integrator,
        allowSwitchChain: false,
      };
      const quote = await this.lifiPost<{ routes?: QuoteRoute[]; route?: QuoteRoute }>('/quote', body);
      const route = quote?.routes?.[0] ?? quote?.route;
      if (!route) return null;
      return { route, id: route.id };
    });
  }

  private async buildTransaction(route: QuoteRoute): Promise<Record<string, unknown> | null> {
    return this.paced(async () => {
      const built = await this.lifiPost<{ transactionRequest?: Record<string, unknown>; transaction?: Record<string, unknown> }>(
        '/build-transaction',
        { route }
      );
      return built?.transactionRequest ?? built?.transaction ?? null;
    });
  }

  private async pollStatus(routeId: string, timeoutMs: number): Promise<{ status: string; txHash?: string } | null> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      const status = await this.lifiGet<{ status?: string; txHash?: string }>(`/status?uuid=${encodeURIComponent(routeId)}`);
      const s = status?.status?.toUpperCase();
      if (s === 'DONE' || s === 'FAILED' || s === 'INVALID') {
        return { status: s, txHash: status?.txHash };
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    return null;
  }

  private evmAccount(chainKey?: ExecutionChainKey): Account {
    if (this.wallet) return this.wallet.getEvmAccount();
    const key = (chainKey ? this.evmPrivateKeyForChain(chainKey) : this.evmPrivateKey);
    if (!key) throw new Error(`EVM private key not configured for chain '${chainKey ?? 'shared'}' — cannot sign EVM execution`);
    const formatted = key.startsWith('0x') ? key : `0x${key}`;
    return privateKeyToAccount(formatted as `0x${string}`);
  }

  private async broadcastEVM(chainKey: Exclude<ExecutionChainKey, 'sol'>, tx: Record<string, unknown>, nonce: string): Promise<string> {
    if (this.broadcastNonces.has(nonce)) throw new Error(`nonce ${nonce} already broadcast — idempotent guard`);
    this.broadcastNonces.add(nonce);
    this.recordBroadcast(nonce); // R3: persist before broadcast
    const account = this.evmAccount(chainKey);
    const walletClient = createWalletClient({ account, chain: EVM_CHAIN_IDS[chainKey], transport: http(EVM_RPC[chainKey]) });
    const txHash = await walletClient.sendTransaction({
      account,
      chain: walletClient.chain || null,
      to: String(tx.to) as `0x${string}`,
      data: String(tx.data ?? '0x') as `0x${string}`,
      value: BigInt(String(tx.value ?? 0)),
    });
    this.recordBroadcast(nonce, { txHash }); // R3: persist settlement hash
    return txHash;
  }

  private async broadcastSolana(tx: Record<string, unknown>, nonce: string): Promise<string> {
    if (this.broadcastNonces.has(nonce)) throw new Error(`nonce ${nonce} already broadcast — idempotent guard`);
    this.broadcastNonces.add(nonce);
    this.recordBroadcast(nonce); // R3: persist before broadcast
    if (!this.solanaPrivateKey) throw new Error('SOLANA_PRIVATE_KEY not configured — cannot sign Solana execution');
    const solana = await import('@solana/web3.js');
    const decoded = base58.decode(this.solanaPrivateKey);
    const keypair = solana.Keypair.fromSecretKey(decoded);
    const serialized = String(tx.transaction ?? tx.tx ?? '');
    if (!serialized) throw new Error('LI.FI Solana build-transaction returned no serialized transaction');
    const txBytes = Uint8Array.from(Buffer.from(serialized, 'base64'));
    const transaction = solana.Transaction.from(txBytes);
    if (!transaction.feePayer) transaction.feePayer = keypair.publicKey;
    transaction.sign(keypair);
    const connection = new solana.Connection(EVM_RPC.sol);
    const txHash = await solana.sendAndConfirmTransaction(connection, transaction, [keypair]);
    this.recordBroadcast(nonce, { txHash }); // R3: persist settlement hash
    return txHash;
  }

  /**
   * Widened Q09 execution seam. Side 'buy' is fully supported; 'sell' is
   * fail-closed for now (sells are handled by the position-manager's own path).
   */
  public async submit(req: LifiSubmitRequest): Promise<LifiFillResult> {
    const chainKey = normalizeExecutionChainKey(req.chain);
    if (!chainKey) {
      return this.failed(`unknown chain '${req.chain}' — fail-closed`);
    }
    if (req.side !== 'buy') {
      return this.failed(`side '${req.side}' not supported by LI.FI executor yet — fail-closed`);
    }
    const cfg = resolveExecutionChain(chainKey);
    try {
      const funding = resolveFundingToken(chainKey, process.env[`EXECUTION_FUNDING_TOKEN_${chainKey.toUpperCase()}`]);
      const fromAmount = BigInt(Math.round(req.amountUsd * 10 ** funding.decimals)).toString();
      const addr = this.addressOf(chainKey);
      const quoted = await this.quoteRoute({
        fromChain: cfg.lifiChainId,
        toChain: cfg.lifiChainId,
        fromToken: funding.address,
        toToken: req.token,
        fromAmount,
        fromAddress: addr,
        toAddress: addr,
      });
      if (!quoted) return this.failed(`LI.FI quote failed for ${req.token} on ${chainKey}`);

      const built = await this.buildTransaction(quoted.route);
      if (!built) return this.failed(`LI.FI build-transaction failed for ${req.token} on ${chainKey}`);

      const nonce = `${chainKey}:${req.token}:${req.amountUsd}:${Math.round(this.now() / 1000)}`;
      if (this.isDryRun) {
        return {
          outcome: 'simulated',
          simulated: true,
          at: this.now(),
          reason: 'DRY_RUN — real quote + built transaction, no broadcast',
        };
      }
      const txHash =
        chainKey === 'sol'
          ? await this.broadcastSolana(built, nonce)
          : await this.broadcastEVM(chainKey, built, nonce);
      const explorerUrl = explorerUrlForChain(chainKey, txHash);
      const status = quoted.id ? await this.pollStatus(quoted.id, req.timeoutMs ?? this.executionTimeoutMs) : null;
      if (status?.status === 'FAILED' || status?.status === 'INVALID') {
        this.recordBroadcast(nonce, { outcome: 'failed', txHash }); // R3
        return this.failed(`LI.FI status ${status.status}`, txHash, explorerUrl);
      }
      if (status === null) {
        this.recordBroadcast(nonce, { outcome: 'timed_out', txHash }); // R3
        return { outcome: 'timed_out', txHash, explorerUrl, reason: 'no status receipt in window', at: this.now() };
      }
      this.recordBroadcast(nonce, { outcome: 'confirmed', txHash: status.txHash ?? txHash }); // R3
      return { outcome: 'confirmed', txHash: status.txHash ?? txHash, explorerUrl, at: this.now() };
    } catch (err: unknown) {
      return this.failed(err instanceof Error ? err.message : String(err));
    }
  }

  /** Manual /swap through LI.FI (same-chain token swap). */
  public async swap(req: LifiSwapRequest): Promise<{
    success: boolean;
    chainName: string;
    chainId: number;
    fromToken: string;
    toToken: string;
    amountIn: number;
    expectedAmountOut: number;
    feeUsd: number;
    estimatedDurationSeconds: number;
    explorerUrl?: string;
    webUrl: string;
    txHash?: string;
    simulated: boolean;
    error?: string;
  }> {
    const chainKey = normalizeExecutionChainKey(req.chain);
    if (!chainKey) {
      return this.swapErr(req, 0, `unknown chain '${req.chain}'`);
    }
    const cfg = resolveExecutionChain(chainKey);
    try {
      const fromAddress = this.resolveAnyToken(chainKey, req.fromToken);
      const toAddress = this.resolveAnyToken(chainKey, req.toToken);
      const fromMeta = this.resolveAnyTokenMeta(chainKey, req.fromToken);
      const fromAmount = BigInt(Math.round(req.amount * 10 ** fromMeta.decimals)).toString();
      const addr = this.addressOf(chainKey);
      const quoted = await this.quoteRoute({
        fromChain: cfg.lifiChainId,
        toChain: cfg.lifiChainId,
        fromToken: fromAddress,
        toToken: toAddress,
        fromAmount,
        fromAddress: addr,
        toAddress: addr,
      });
      if (!quoted) return this.swapErr(req, cfg.lifiChainId, 'LI.FI swap quote failed', cfg.key);
      const expected = Number(quoted.route.toAmount ?? '0');
      const webUrl = this.swapWebUrl(cfg.lifiChainId, fromAddress, toAddress, req.amount);
      const built = await this.buildTransaction(quoted.route);
      if (!built) return { ...this.swapErr(req, cfg.lifiChainId, 'LI.FI build-transaction failed', cfg.key), webUrl, expectedAmountOut: expected };
      if (this.isDryRun) {
        return { success: true, chainName: cfg.key, chainId: cfg.lifiChainId, fromToken: req.fromToken, toToken: req.toToken, amountIn: req.amount, expectedAmountOut: expected, feeUsd: 0, estimatedDurationSeconds: 0, webUrl, simulated: true };
      }
      const nonce = `swap:${chainKey}:${req.fromToken}:${req.toToken}:${req.amount}`;
      const txHash = chainKey === 'sol' ? await this.broadcastSolana(built, nonce) : await this.broadcastEVM(chainKey, built, nonce);
      return { success: true, chainName: cfg.key, chainId: cfg.lifiChainId, fromToken: req.fromToken, toToken: req.toToken, amountIn: req.amount, expectedAmountOut: expected, feeUsd: 0, estimatedDurationSeconds: 0, explorerUrl: explorerUrlForChain(chainKey, txHash), webUrl, txHash, simulated: false };
    } catch (err: unknown) {
      return { ...this.swapErr(req, cfg.lifiChainId, err instanceof Error ? err.message : String(err), cfg.key), webUrl: this.swapWebUrl(cfg.lifiChainId, req.fromToken, req.toToken, req.amount) };
    }
  }

  /** Manual /send — native-coin transfer via the wallet signer (LI.FI is swaps only). */
  public async send(req: LifiSendRequest): Promise<{
    success: boolean;
    chainName: string;
    chainId: number;
    tokenSymbol: string;
    amountIn: number;
    expectedAmountOut: number;
    feeUsd: number;
    estimatedDurationSeconds: number;
    recipientAddress: string;
    explorerUrl?: string;
    webUrl: string;
    txHash?: string;
    simulated: boolean;
    error?: string;
  }> {
    const chainKey = normalizeExecutionChainKey(req.chain);
    if (!chainKey) {
      return { success: false, chainName: String(req.chain), chainId: 0, tokenSymbol: req.token, amountIn: req.amount, expectedAmountOut: req.amount, feeUsd: 0, estimatedDurationSeconds: 0, recipientAddress: req.recipientAddress, webUrl: '', simulated: true, error: `unknown chain '${req.chain}'` };
    }
    const cfg = resolveExecutionChain(chainKey);
    const symbol = req.token.toUpperCase();
    const webUrl = this.sendWebUrl(cfg.lifiChainId, req.recipientAddress, req.amount);
    try {
      if (this.isDryRun) {
        return { success: true, chainName: cfg.key, chainId: cfg.lifiChainId, tokenSymbol: symbol, amountIn: req.amount, expectedAmountOut: req.amount, feeUsd: 0, estimatedDurationSeconds: 0, recipientAddress: req.recipientAddress, webUrl, simulated: true };
      }
      if (chainKey === 'sol') {
        if (this.wallet?.sendSolana) {
          const txHash = await this.wallet.sendSolana(req.recipientAddress, Math.round(req.amount * 1e9));
          return { success: true, chainName: cfg.key, chainId: cfg.lifiChainId, tokenSymbol: symbol, amountIn: req.amount, expectedAmountOut: req.amount, feeUsd: 0, estimatedDurationSeconds: 0, recipientAddress: req.recipientAddress, explorerUrl: explorerUrlForChain('sol', txHash), webUrl, txHash, simulated: false };
        }
        if (!this.solanaPrivateKey) throw new Error('SOLANA_PRIVATE_KEY not configured');
        const solana = await import('@solana/web3.js');
        const keypair = solana.Keypair.fromSecretKey(base58.decode(this.solanaPrivateKey));
        const connection = new solana.Connection(EVM_RPC.sol);
        const to = new solana.PublicKey(req.recipientAddress);
        const tx = new solana.Transaction().add(
          solana.SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: to, lamports: Math.round(req.amount * 1e9) })
        );
        const txHash = await solana.sendAndConfirmTransaction(connection, tx, [keypair]);
        return { success: true, chainName: cfg.key, chainId: cfg.lifiChainId, tokenSymbol: symbol, amountIn: req.amount, expectedAmountOut: req.amount, feeUsd: 0, estimatedDurationSeconds: 0, recipientAddress: req.recipientAddress, explorerUrl: explorerUrlForChain('sol', txHash), webUrl, txHash, simulated: false };
      }
      if (symbol !== cfg.nativeCoin) {
        throw new Error(`send supports native ${cfg.nativeCoin} only — token transfers via /swap`);
      }
      const account = this.evmAccount(chainKey);
      const walletClient = createWalletClient({ account, chain: EVM_CHAIN_IDS[chainKey], transport: http(EVM_RPC[chainKey]) });
      const txHash = await walletClient.sendTransaction({
        account,
        chain: walletClient.chain || null,
        to: req.recipientAddress as `0x${string}`,
        value: BigInt(Math.round(req.amount * 1e18)),
      });
      return { success: true, chainName: cfg.key, chainId: cfg.lifiChainId, tokenSymbol: symbol, amountIn: req.amount, expectedAmountOut: req.amount, feeUsd: 0, estimatedDurationSeconds: 0, recipientAddress: req.recipientAddress, explorerUrl: explorerUrlForChain(chainKey, txHash), webUrl, txHash, simulated: false };
    } catch (err: unknown) {
      return { success: false, chainName: cfg.key, chainId: cfg.lifiChainId, tokenSymbol: symbol, amountIn: req.amount, expectedAmountOut: req.amount, feeUsd: 0, estimatedDurationSeconds: 0, recipientAddress: req.recipientAddress, webUrl, simulated: true, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private addressOf(chainKey: ExecutionChainKey): string {
    if (chainKey === 'sol') return process.env.SOLANA_WALLET_ADDRESS || '';
    if (this.wallet) {
      try {
        return this.wallet.getEvmAccount().address;
      } catch {
        return '';
      }
    }
    const key = this.evmPrivateKeyForChain(chainKey);
    if (key) {
      const formatted = key.startsWith('0x') ? key : `0x${key}`;
      return privateKeyToAccount(formatted as `0x${string}`).address;
    }
    return '';
  }

  /** Resolve a symbol-or-address into a concrete token address. */
  private resolveAnyToken(chainKey: ExecutionChainKey, symbolOrAddress: string): string {
    return this.resolveAnyTokenMeta(chainKey, symbolOrAddress).address;
  }

  private resolveAnyTokenMeta(chainKey: ExecutionChainKey, symbolOrAddress: string): { address: string; decimals: number } {
    const s = symbolOrAddress.trim();
    const native = NATIVE_TOKEN_META[s.toUpperCase()];
    if (native) return native;
    if (/^0x/i.test(s) && s.length >= 40) return { address: s, decimals: 18 };
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return { address: s, decimals: 9 }; // solana base58 mint
    const funding = resolveFundingToken(chainKey, s);
    return { address: funding.address, decimals: funding.decimals };
  }

  private swapWebUrl(chainId: number, from: string, to: string, amount: number): string {
    return `https://jumper.exchange/?fromChain=${chainId}&toChain=${chainId}&fromToken=${encodeURIComponent(from)}&toToken=${encodeURIComponent(to)}&fromAmount=${amount}`;
  }

  private sendWebUrl(chainId: number, recipient: string, amount: number): string {
    return `https://jumper.exchange/?fromChain=${chainId}&toChain=${chainId}&toAddress=${encodeURIComponent(recipient)}&fromAmount=${amount}`;
  }

  private failed(reason: string, txHash?: string, explorerUrl?: string): LifiFillResult {
    return { outcome: 'failed', txHash, explorerUrl, reason, at: this.now() };
  }

  private swapErr(req: LifiSwapRequest, chainId: number, error: string, chainName = String(req.chain)) {
    return {
      success: false,
      chainName,
      chainId,
      fromToken: req.fromToken,
      toToken: req.toToken,
      amountIn: req.amount,
      expectedAmountOut: 0,
      feeUsd: 0,
      estimatedDurationSeconds: 0,
      webUrl: '',
      simulated: true,
      error,
    };
  }
}

/** Process-wide singleton — holds the LI.FI pacing queue and key state. */
export const globalLifiExecutor = new LifiExecutor();
