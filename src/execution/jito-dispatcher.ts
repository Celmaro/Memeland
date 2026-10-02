/**
 * T1 — Production Solana Jito bundle ingestion & dispatcher (opt-in, MEV-safe).
 *
 * Never submit standard txns to public Solana RPC for entry: public-mempool
 * broadcast invites sandwich frontrunning. This dispatcher assembles a Jito
 * bundle — ComputeBudget (tight CU), idempotent ATA create, AMM swap, dynamic
 * tip transfer — signs it, and broadcasts the serialized bundle to multiple
 * regional Jito block-engine endpoints over private channels.
 *
 * OPT-IN & INTEGRITY NOTE: this module is NOT wired into the LI.FI execution
 * path. It is a standalone capability for a Solana MEV execution lane, enabled
 * only by an operator who explicitly routes Solana fills through it. Tip-floor
 * data and block-engine URLs come from the public Jito API (real, provided in
 * the spec). It is fail-open: a tip-floor read error falls back to a floor
 * constant; only a total broadcast failure (all regions) throws.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTxvQssQnNedMpGizQmqmiW24mwVaPnJy5PB',
  'Cw8CFyM9FkoMi7K7Crnq6HNQqf4uAzNmrZn6rUMBVnN7',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
].map((a) => new PublicKey(a));

export const DEFAULT_BLOCK_ENGINE_URLS = [
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
];
export const TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

export const TIP_MULTIPLIER = 1.15;
export const MIN_TIP_LAMPORTS = 1_000_000; // 0.001 SOL floor
export const TIP_FALLBACK_LAMPORTS = 1_500_000; // 0.0015 SOL
export const COMPUTE_UNITS = 120_000;
export const COMPUTE_UNIT_PRICE = 50_000;

export interface JitoDispatchOptions {
  connection: Connection;
  payer: Keypair;
  /** Injectable HTTP POST (tests); defaults to global fetch. */
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
    ok: boolean;
    json: () => Promise<unknown>;
  }>;
  tipFloorUrl?: string;
  blockEngineUrls?: string[];
  tipMultiplier?: number;
  /** Injected random tip-account picker (tests). */
  pickTipAccount?: () => PublicKey;
}

export class JitoBundleDispatcher {
  private readonly connection: Connection;
  private readonly payer: Keypair;
  private readonly fetchImpl: NonNullable<JitoDispatchOptions['fetchImpl']>;
  private readonly tipFloorUrl: string;
  private readonly blockEngineUrls: string[];
  private readonly tipMultiplier: number;
  private readonly pickTipAccount: () => PublicKey;

  constructor(opts: JitoDispatchOptions) {
    this.connection = opts.connection;
    this.payer = opts.payer;
    this.fetchImpl =
      opts.fetchImpl ??
      ((url, init) =>
        (globalThis as { fetch: typeof fetch }).fetch(url, { ...init, signal: AbortSignal.timeout(1500) }));
    this.tipFloorUrl = opts.tipFloorUrl ?? TIP_FLOOR_URL;
    this.blockEngineUrls = opts.blockEngineUrls ?? DEFAULT_BLOCK_ENGINE_URLS;
    this.tipMultiplier = opts.tipMultiplier ?? TIP_MULTIPLIER;
    this.pickTipAccount =
      opts.pickTipAccount ??
      (() => JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]!);
  }

  /**
   * Dynamic tip floor: query the live 95th-percentile landed tip and lift it by
   * `tipMultiplier`, floored at 0.001 SOL. On any read failure, a safe fallback.
   */
  public async getDynamicTipLamports(): Promise<number> {
    try {
      const res = await this.fetchImpl(this.tipFloorUrl, {
        method: 'GET',
        headers: { 'content-type': 'application/json' },
        body: '',
      });
      if (!res.ok) return TIP_FALLBACK_LAMPORTS;
      const data = (await res.json()) as Array<{ landed_tips_95th_percentile?: number }>;
      const p95 = data?.[0]?.landed_tips_95th_percentile;
      if (typeof p95 !== 'number' || !Number.isFinite(p95)) return TIP_FALLBACK_LAMPORTS;
      const p95Lamports = Math.floor(p95 * 1e9);
      return Math.max(Math.floor(p95Lamports * this.tipMultiplier), MIN_TIP_LAMPORTS);
    } catch {
      return TIP_FALLBACK_LAMPORTS;
    }
  }

  /**
   * Assemble the deterministic bundle (ComputeBudget + ATA + swap + tip transfer),
   * sign it, and broadcast the serialized v0 transaction to every configured
   * block-engine endpoint concurrently. Returns the bundle ids; throws only when
   * EVERY region rejects the bundle (a total dispatch failure).
   *
   * The idempotent ATA create must be prepared by the caller and passed as the
   * first swap-adjacent instruction if required (the dispatcher does not assume
   * an ATA exists). Caller-provided `swapInstructions` are inserted after the
   * ComputeBudget instructions.
   */
  public async assembleAndBroadcastBundle(swapInstructions: TransactionInstruction[] = []): Promise<string[]> {
    const tipLamports = await this.getDynamicTipLamports();
    const tipAccount = this.pickTipAccount();

    const instructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
      ...swapInstructions,
      SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      }),
    ];

    const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
      payerKey: this.payer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([this.payer]);
    const serializedTx = Buffer.from(transaction.serialize()).toString('base64');

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [[serializedTx]],
    };

    const results = await Promise.all(
      this.blockEngineUrls.map((url) =>
        this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then(async (r) => (r.ok ? ((await r.json()) as { result?: unknown }).result : null))
          .catch(() => null),
      ),
    );

    const validBundleIds = results.filter((r): r is string => typeof r === 'string');
    if (validBundleIds.length === 0) {
      throw new Error('Failed to dispatch Jito bundle to any regional block engine.');
    }
    return validBundleIds;
  }
}