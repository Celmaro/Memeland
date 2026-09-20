import { describe, it, expect } from 'vitest';
import { ok, err, unwrap, clampSize, firstFail, type Result, type AdapterError } from '../src/adapters/result.js';

describe('Result<T,E> (PR 2 / Kernel E — PELLET)', () => {
  it('ok/err produce the tagged union', () => {
    const good = ok(42);
    const bad = err<number, AdapterError>({ code: 'X', message: 'boom', retryable: false });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value).toBe(42);
    expect(bad.ok).toBe(false);
  });

  it('unwrap throws the error when the result is err', () => {
    const bad = err<number, AdapterError>({ code: 'X', message: 'boom', retryable: false });
    expect(() => unwrap(bad)).toThrow('boom');
    expect(unwrap(ok(7))).toBe(7);
  });
});

describe('clampSize (PR 2 / Kernel E — FLYWHEEL fail-safe SKIP)', () => {
  it('clamps a model-returned over-max size to the cap', () => {
    const r = clampSize(5, 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(2);
  });

  it('leaves a within-cap size unchanged', () => {
    const r = clampSize(0.5, 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(0.5);
  });

  it('rejects a non-finite size as an explicit veto', () => {
    const r = clampSize(Number.NaN, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OVERRIDE_INVALID');
  });
});

describe('firstFail (PR 2 / Kernel E — ordered risk-gatechain)', () => {
  it('short-circuits and returns the first failure in order', async () => {
    const calls: string[] = [];
    const r = await firstFail([
      async () => { calls.push('a'); return ok(true); },
      async () => { calls.push('b'); return err({ code: 'GATE_B', message: 'b failed', retryable: false }); },
      async () => { calls.push('c'); return ok(true); },
    ]);
    expect(calls).toEqual(['a', 'b']);
    expect(r.ok).toBe(false);
  });

  it('resolves ok when every gate passes', async () => {
    const r = await firstFail([
      async () => ok(true),
      async () => ok(true),
    ]);
    expect(r.ok).toBe(true);
  });
});
