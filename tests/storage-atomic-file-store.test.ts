import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomicFileStore, atomicWriteJsonSync, readJsonFileSafe } from '../src/storage/atomic-file-store.js';

describe('atomic JSON store', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeland-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('writes atomically and reads back the snapshot', () => {
    const file = path.join(dir, 'state.json');
    atomicWriteJsonSync(file, { ok: true, count: 1 });
    expect(readJsonFileSafe(file, { ok: false })).toEqual({ ok: true, count: 1 });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('uses fallback for missing or corrupt files', () => {
    const missing = path.join(dir, 'missing.json');
    expect(readJsonFileSafe(missing, { fallback: true })).toEqual({ fallback: true });
    const corrupt = path.join(dir, 'corrupt.json');
    fs.writeFileSync(corrupt, 'not json');
    expect(readJsonFileSafe(corrupt, { fallback: true })).toEqual({ fallback: true });
  });

  it('coalesces debounced writes', async () => {
    vi.useFakeTimers();
    const file = path.join(dir, 'state.json');
    const store = new AtomicFileStore(file, { count: 0 }, { debounceMs: 10 });
    store.set({ count: 1 });
    store.set({ count: 2 });
    expect(fs.existsSync(file)).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(readJsonFileSafe(file, { count: 0 })).toEqual({ count: 2 });
  });
});
