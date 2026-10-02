/**
 * T1 — Helius webhook ingress engine (fastify-free, `node:http`).
 *
 * Decoupled Solana discovery: instead of polling a feed, the operator registers
 * a Helius webhook that POSTs transaction batches here; the receiver validates
 * auth, filters successful pump.fun interactions, and pushes candidate records
 * into a Redis stream (`solana:discovery:stream`, MAXLEN ~ N) for downstream
 * atomic state reducers to consume. Net-new — there is no prior Helius module.
 *
 * Built without fastify to avoid a new runtime dependency; the core handler is a
 * plain `(req, res) => Promise<void>` so it is testable without opening a socket
 * and with an injectable writer + body reader.
 *
 * Fail-open: an unreachable/missing Redis writer must NOT turn a webhook POST
 * into an error — the receiver still acks, and any drop is logged/ignored. A
 * malformed request (bad auth, bad JSON, wrong shape) is rejected with a clean
 * 4xx; it never throws into the HTTP layer.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** Writer contract — the Redis XADD seam, injectable for tests. */
export interface IngressWriter {
  xadd(stream: string, ...args: (string | number)[]): Promise<unknown>;
}

export interface HeliusIngressOptions {
  webhookSecret: string;
  /** pump.fun program id. Overridable via env. */
  pumpFunProgramId?: string;
  streamKey?: string;
  maxLen?: number;
  writer?: IngressWriter;
  readBody?: (req: IncomingMessage) => Promise<string>;
  now?: () => number;
}

/** Default pump.fun program id. */
export const DEFAULT_PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const DEFAULT_DISCOVERY_STREAM = 'solana:discovery:stream';
export const DEFAULT_MAXLEN = 10000;

/** Lazy ioredis-backed writer; fail-open (no-ops) when Redis is absent or errors. */
export function createRedisIngressWriter(): IngressWriter {
  let client: any = null;
  return {
    async xadd(stream: string, ...args: (string | number)[]): Promise<unknown> {
      try {
        if (!client) {
          const url =
            process.env.REDIS_URL ??
            process.env.REDIS_URI ??
            process.env.REDIS_CONNECTION_STRING ??
            '';
          if (!url) return null; // no Redis → drop silently (fail-open)
          const { Redis } = await import('ioredis');
          client = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
        }
        return await client.xadd(stream, ...args);
      } catch {
        return null; // transport error → drop, never throw
      }
    },
  };
}

/** Real body reader for node:http (streaming, size-capped). */
export async function readRequestBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > maxBytes) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * The core handler. Returns a `(req, res) => Promise<void>` that validates auth,
 * parses, filters pump.fun interactions, writes to the stream, and acks. Never
 * throws — all rejection paths set an HTTP status and end the response.
 */
export function createHeliusIngressHandler(opts: HeliusIngressOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const secret = opts.webhookSecret;
  const programId = opts.pumpFunProgramId ?? DEFAULT_PUMPFUN_PROGRAM_ID;
  const streamKey = opts.streamKey ?? DEFAULT_DISCOVERY_STREAM;
  const maxLen = opts.maxLen ?? DEFAULT_MAXLEN;
  const writer = opts.writer ?? createRedisIngressWriter();
  const readBody = opts.readBody ?? readRequestBody;
  const now = opts.now ?? (() => Date.now());

  return async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'POST') return send(405, { error: 'Method Not Allowed' });
    if (req.headers['authorization'] !== secret) return send(401, { error: 'Unauthorized' });

    let text: string;
    try {
      text = await readBody(req);
    } catch {
      return send(400, { error: 'Invalid body' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return send(400, { error: 'Invalid JSON' });
    }
    if (!Array.isArray(payload)) return send(400, { error: 'Invalid payload format' });

    let written = 0;
    for (const tx of payload) {
      const m = tx as Record<string, unknown> | null;
      // Keep only successful txs (meta.err === null).
      const meta = m?.meta as { err?: unknown } | undefined;
      if (meta && meta.err !== null) continue;

      const instructions = (m?.instructions ?? []) as Array<{ programId?: string; accounts?: string[] }>;
      for (const ix of instructions) {
        if (ix.programId !== programId) continue;
        const accounts = ix.accounts ?? [];
        const mint = accounts[0];
        const bondingCurve = accounts[2];
        if (!mint || !bondingCurve) continue;
        const record = {
          chain: 'sol',
          mint,
          bondingCurve,
          deployer: (m?.feePayer as string | undefined) ?? null,
          signature: (m?.signature as string | undefined) ?? null,
          slot: (m?.slot as number | undefined) ?? 0,
          firstSeenTimestamp: now(),
        };
        try {
          await writer.xadd(streamKey, 'MAXLEN', '~', String(maxLen), '*', 'data', JSON.stringify(record));
          written += 1;
        } catch {
          // fail-open: drop, keep acking
        }
      }
    }

    return send(200, { status: 'acknowledged', written });
  };
}

/** Build a runnable `http.Server` wrapping the handler (for production use). */
export function buildHeliusIngressServer(opts: HeliusIngressOptions): ReturnType<typeof createServer> {
  const handler = createHeliusIngressHandler(opts);
  return createServer((req, res) => {
    handler(req, res).catch(() => {
      res.statusCode = 500;
      res.end('{"error":"internal"}');
    });
  });
}
