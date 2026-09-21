import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CronSchedulerService } from '../src/services/cron-scheduler.js';
import { atomicWriteJsonSync, readJsonFileSafe } from '../src/storage/atomic-file-store.js';

describe('CronScheduler atomic persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeland-cron-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists schedules through the atomic JSON store and reloads them', () => {
    const dbPath = path.join(dir, 'schedules', 'schedules.json');
    const scheduler = new CronSchedulerService(dbPath);
    const task = scheduler.addSchedule('every 4 hours', 'screening', 'whale-eth');

    const disk = readJsonFileSafe<Array<{ id: string }>>(dbPath, []);
    expect(disk.some((entry) => entry.id === task.id)).toBe(true);
    expect(fs.existsSync(`${dbPath}.tmp`)).toBe(false);

    const reloaded = new CronSchedulerService(dbPath);
    expect(reloaded.getAllSchedules().some((entry) => entry.id === task.id)).toBe(true);

    reloaded.removeSchedule(task.id);
    scheduler.removeSchedule(task.id);
  });

  it('writes a valid empty db when no schedules exist yet', () => {
    const dbPath = path.join(dir, 'empty', 'schedules.json');
    new CronSchedulerService(dbPath);
    const flushed = readJsonFileSafe<unknown[]>(dbPath, [{ unexpected: true }]);
    atomicWriteJsonSync(dbPath, flushed);
    expect(readJsonFileSafe<unknown[]>(dbPath, [{ unexpected: true }])).toEqual([]);
  });
});
