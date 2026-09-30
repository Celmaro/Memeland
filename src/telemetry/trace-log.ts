/**
 * 6.2 — Structured logger + per-pass trace id.
 *
 * Adapters log ad hoc `[PRICE SERVICE ERROR]`, `[GMGN ERROR]`, `[DISCOVERY]`,
 * `[AGENT RUNNER]` with no shared schema or correlation id. This provides a tiny,
 * dependency-free structured emitter: every line carries a stable JSON schema
 * `{ ts, traceId, level, event, ...fields }`, and a per-pass `traceId` lets you
 * answer "what did this pass actually touch" without text-grep. Pairs with 6.1
 * (the pass_receipt) to make a pass reproducible.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Generate a short, collision-safe trace id for a pass/call. */
export function newTraceId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
}

/** Structured fields allowed in a log line (JSON-serializable). */
export type StructuredFields = Record<string, unknown>;

/**
 * Emit one structured log line. Always emits a stable JSON shape so a log
 * collector / query can slice by traceId, level, or event without regex.
 */
export function structuredLog(
  traceId: string,
  level: LogLevel,
  event: string,
  fields: StructuredFields = {},
  ts: string = new Date().toISOString(),
): void {
  const line = JSON.stringify({ ts, traceId, level, event, ...fields });
  // eslint-disable-next-line no-console
  console.log(`[STRUCTURED] ${line}`);
}

/**
 * A per-pass tracer. Holds a traceId for the whole pass so every structured line
 * is correlated. `child(tag)` fans out a sub-context (e.g. per-source) while
 * preserving the parent correlation id.
 */
export class PassTracer {
  readonly traceId: string;

  constructor(traceId: string = newTraceId()) {
    this.traceId = traceId;
  }

  public log(level: LogLevel, event: string, fields: StructuredFields = {}): void {
    structuredLog(this.traceId, level, event, fields);
  }

  public info(event: string, fields: StructuredFields = {}): void {
    this.log('info', event, fields);
  }

  public warn(event: string, fields: StructuredFields = {}): void {
    this.log('warn', event, fields);
  }

  public error(event: string, fields: StructuredFields = {}): void {
    this.log('error', event, fields);
  }

  /** A sub-context (per-source / per-chain) sharing the parent correlation id. */
  public child(tag: string): PassTracer {
    return new PassTracer(`${this.traceId}#${tag}`);
  }
}