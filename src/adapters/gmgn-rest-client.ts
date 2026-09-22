/**
 * Kernel U — GmgnRestClient: the GMGN OpenAPI transport seam, extracted
 * byte-for-byte from gmgn-adapter.ts. Owns key-pool rotation, global pacing,
 * retry/429 handling, and the signed request envelope. GMGNAdapter extends
 * this class so every public data method keeps its exact behavior.
 */

import crypto from 'node:crypto';
import { createApiKeyPool, loadApiKeyPool, type ApiKeyPool } from '../services/api-key-pool.js';

/** All chains GMGN OpenAPI serves for market/token/track routes (multi-chain expansion, 2026-09-18). */
export type Chain = 'sol' | 'bsc' | 'base' | 'eth' | 'robinhood';

export const GMGN_CHAINS: Chain[] = ['sol', 'bsc', 'base', 'eth', 'robinhood'];

/**
 * Global pacing queue — ALL GMGN requests (every adapter instance: meme
 * robinhood, LP enrich, etc.) queue here with minimal spacing
 * so requests do not collide within a 5-minute session. GMGN uses
 * a leaky bucket rate=20/capacity=20 per key — with this spacing, bursts
 * (e.g. 30 simultaneous LP enrich requests) spread out automatically.
 */
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

export class GmgnRestClient {
  protected baseUrl = 'https://openapi.gmgn.ai';
  protected keyPool: ApiKeyPool;
  private readonly requestSpacingMs = Math.max(
    100,
    Number(process.env.GMGN_REQUEST_SPACING_MS || 300)
  );

  constructor(apiKey?: string) {
    // Per-chain key pools: GMGN_API_KEY_SOL / GMGN_API_KEY_BSC / GMGN_API_KEY_BASE /
    // GMGN_API_KEY_ETH / GMGN_API_KEY_ROBINHOOD each contribute to ONE rotation pool
    // (plus legacy GMGN_API_KEY + *_BACKUP_KEYS + indexed slots via loadApiKeyPool).
    const perChainAliases = GMGN_CHAINS.map((c) => `GMGN_API_KEY_${c.toUpperCase()}`);
    const envPool = loadApiKeyPool('GMGN_API_KEY', ['GMGN_API_KEY_ROBINHOOD', ...perChainAliases]);
    this.keyPool = apiKey
      ? createApiKeyPool('GMGN_API_KEY', [apiKey, ...envPool.keys])
      : envPool;
  }

  private async paced<T>(fn: () => Promise<T>): Promise<T> {
    const prev = requestQueue;
    let release!: () => void;
    requestQueue = new Promise((r) => { release = r; });
    await prev;
    try {
      const wait = Math.max(0, lastRequestAt + this.requestSpacingMs - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Signed GMGN request with key-pool rotation + 429/401 backoff. Returns null
   * on any failure (fail-closed). `retries` = additional attempts after the
   * first; the pool's backup keys are tried immediately on 429/401/402/403.
   */
  protected async gmgnRequest<T>(
    method: 'GET' | 'POST',
    subPath: string,
    query: Record<string, string | number | string[] | number[]> = {},
    body?: unknown,
    retries = 1
  ): Promise<T | null> {
    if (this.keyPool.size === 0) return null;
    const doRequest = async (attemptsLeft: number): Promise<T | null> => {
      const currentKey = this.keyPool.get() || '';
      if (!currentKey) return null;
      const timestamp = Math.floor(Date.now() / 1000);
      const client_id = crypto.randomUUID();
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (Array.isArray(v)) {
          for (const item of v) params.append(k, String(item));
        } else {
          params.set(k, String(v));
        }
      }
      params.set('timestamp', String(timestamp));
      params.set('client_id', client_id);
      const url = `${this.baseUrl}${subPath}?${params.toString()}`;
      try {
        const res = await fetch(url, {
          method,
          headers: { 'X-APIKEY': currentKey, 'Content-Type': 'application/json', 'User-Agent': 'opencatz/1.0' },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (res.status === 429) {
          // If we have backup keys available in the pool, rotate immediately without waiting!
          if (this.keyPool.size > 1 && attemptsLeft > 0) {
            const next = this.keyPool.markFailed(`Rate limit 429 on ${subPath}`);
            if (next && next !== currentKey) {
              console.warn(`[GMGN] ⚡ Rotated immediately to backup key on 429 — retrying ${subPath} (attempts left: ${attemptsLeft - 1}).`);
              return doRequest(attemptsLeft - 1);
            }
          }

          // Polite wait only if single key without backups
          let resetSec = Number(res.headers.get('X-RateLimit-Reset') || 0);
          let banned = false;
          if (!resetSec) {
            try {
              const errBody: any = await res.json();
              resetSec = Number(errBody?.reset_at || 0);
              banned = errBody?.error === 'RATE_LIMIT_BANNED';
            } catch { /* body not JSON */ }
          }
          const waitMs = resetSec > 0 ? Math.max(resetSec * 1000 - Date.now(), 0) + 1000 : 5000;
          if (!banned && attemptsLeft > 0 && waitMs <= 30_000) {
            console.warn(`[GMGN] Rate limited. Waiting ${Math.floor(waitMs / 1000)}s, then retrying once (attempts left: ${attemptsLeft}).`);
            await new Promise((r) => setTimeout(r, waitMs));
            return doRequest(attemptsLeft - 1);
          }
          if (banned) this.keyPool.markFailed('rate limit banned');
          console.warn(`[GMGN] Rate limited${banned ? ' (BANNED)' : ''} — skip ${subPath}, retry on the next pass (~5m).`);
          return null;
        }
        if (res.status === 401 || res.status === 402 || res.status === 403) {
          if (this.keyPool.size > 1 && attemptsLeft > 0) {
            const next = this.keyPool.markFailed(`HTTP ${res.status} on ${subPath}`);
            if (next && next !== currentKey) {
              console.warn(`[GMGN] Rotated to backup key on HTTP ${res.status} — retrying ${subPath} (attempts left: ${attemptsLeft - 1}).`);
              return doRequest(attemptsLeft - 1);
            }
          }
          console.warn(`[GMGN] HTTP ${res.status} for ${subPath}`);
          return null;
        }
        if (!res.ok) { console.warn(`[GMGN] HTTP ${res.status} for ${subPath}`); return null; }
        const json: any = await res.json();
        if (json && typeof json === 'object' && json.code !== undefined && json.code !== 0) {
          console.warn(`[GMGN] API code ${json.code}: ${json.message || json.error || ''}`);
          return null;
        }
        return json as T;
      } catch (err: any) {
        console.error(`[GMGN ERROR] ${subPath}: ${err.message}`);
        return null;
      }
    };
    return this.paced(() => doRequest(retries));
  }
}