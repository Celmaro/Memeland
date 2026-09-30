import { describe, it, expect, vi } from 'vitest';
import { PassTracer, structuredLog, newTraceId } from '../src/telemetry/trace-log.js';

describe('trace-log (6.2 — structured logger + per-pass trace id)', () => {
  it('structuredLog emits a stable JSON schema with the trace id', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    structuredLog('t1', 'info', 'foo.bar', { n: 2 }, '2026-09-30T00:00:00.000Z');
    const line = spy.mock.calls[0]![0] as string;
    expect(line.startsWith('[STRUCTURED] ')).toBe(true);
    const parsed = JSON.parse(line.replace('[STRUCTURED] ', ''));
    expect(parsed).toMatchObject({ ts: '2026-09-30T00:00:00.000Z', traceId: 't1', level: 'info', event: 'foo.bar', n: 2 });
    spy.mockRestore();
  });

  it('PassTracer holds a stable trace id and children share the parent id', () => {
    const t = new PassTracer('abc123');
    expect(t.traceId).toBe('abc123');
    const child = t.child('discovery');
    expect(child.traceId).toBe('abc123#discovery');
  });

  it('warn/error log to the console with the right level', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const t = new PassTracer('t');
    t.warn('sink.down', { source: 'gmgn' });
    t.error('conn.failed', { host: 'x' });
    const warns = spy.mock.calls.filter((c) => (JSON.parse((c[0] as string).replace('[STRUCTURED] ', ''))).level === 'warn');
    const errs = spy.mock.calls.filter((c) => (JSON.parse((c[0] as string).replace('[STRUCTURED] ', ''))).level === 'error');
    expect(warns).toHaveLength(1);
    expect(errs).toHaveLength(1);
    spy.mockRestore();
  });

  it('newTraceId is unique across calls', () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).not.toBe(b);
  });
});