import { describe, it, expect, vi } from 'vitest';
import { Connection, Keypair, SystemProgram } from '@solana/web3.js';
import {
  JitoBundleDispatcher,
  TIP_FALLBACK_LAMPORTS,
  MIN_TIP_LAMPORTS,
  DEFAULT_BLOCK_ENGINE_URLS,
} from './jito-dispatcher.js';

/** Fake HTTP fetch returning a canned JSON body. */
function okJson(body: unknown) {
  return vi.fn(async () => ({ ok: true, json: async () => body }));
}
function httpErr() {
  return vi.fn(async () => ({ ok: false, json: async () => ({}) }));
}

function dispatcher(fetchImpl: unknown, opts: Record<string, unknown> = {}) {
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0 }),
  } as unknown as Connection;
  const payer = Keypair.generate();
  const pickTipAccount = () => payer.publicKey;
  return new JitoBundleDispatcher({
    connection,
    payer,
    fetchImpl: fetchImpl as never,
    pickTipAccount,
    ...opts,
  });
}

describe('JitoBundleDispatcher', () => {
  it('lifts the 95th-percentile tip by the multiplier, floored at 0.001 SOL', async () => {
    const fetchImpl = okJson([{ landed_tips_95th_percentile: 0.01 }]); // 0.01 SOL = 10,000,000 lamports
    const d = dispatcher(fetchImpl);
    const lamports = await d.getDynamicTipLamports();
    expect(lamports).toBe(Math.max(Math.floor(10_000_000 * 1.15), MIN_TIP_LAMPORTS)); // 11,500,000
  });

  it('falls back to the floor constant when the tip API errors', async () => {
    const d = dispatcher(httpErr());
    expect(await d.getDynamicTipLamports()).toBe(TIP_FALLBACK_LAMPORTS);
  });

  it('floors tiny tips up to the minimum', async () => {
    const d = dispatcher(okJson([{ landed_tips_95th_percentile: 0.0000001 }]));
    expect(await d.getDynamicTipLamports()).toBe(MIN_TIP_LAMPORTS);
  });

  it('assembles a signed bundle and broadcasts to every regional endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/tip_floor')) return { ok: true, json: async () => [{ landed_tips_95th_percentile: 0.01 }] };
      return { ok: true, json: async () => ({ result: 'bundle-abc' }) };
    });
    const d = dispatcher(fetchImpl);
    const payer = (d as unknown as { payer: Keypair }).payer;
    const swapInstruction = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 1,
    });
    const ids = await d.assembleAndBroadcastBundle([swapInstruction]);
    expect(ids).toHaveLength(DEFAULT_BLOCK_ENGINE_URLS.length);
    for (const id of ids) expect(id).toBe('bundle-abc');
    // One tip-floor GET + one POST per region.
    expect(fetchImpl).toHaveBeenCalledTimes(1 + DEFAULT_BLOCK_ENGINE_URLS.length);
  });

  it('throws only when every region rejects the bundle (total dispatch failure)', async () => {
    const d = dispatcher(okJson([{ landed_tips_95th_percentile: 0.01 }]));
    const failing = d.assembleAndBroadcastBundle([]);
    // fetchImpl okJson returns { result: undefined } for the sendBundle POST → no valid ids.
    await expect(failing).rejects.toThrow(/Failed to dispatch Jito bundle/);
  });
});
