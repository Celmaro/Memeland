import { describe, it, expect, vi } from 'vitest';
import { ChatNotifier, discordChannelSink } from '../src/notifications/chat-notifier.js';

describe('KC5 / Kernel P — ChatNotifier', () => {
  it('first post goes through; second within cooldown is dropped', async () => {
    let t = 0;
    const sink = vi.fn();
    const n = new ChatNotifier({ sink, now: () => t, cooldownMs: 1000 });
    await n.post('a', 'hi');
    await n.post('a', 'hi again');
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('post after cooldown window fires the sink again', async () => {
    let t = 0;
    const sink = vi.fn();
    const n = new ChatNotifier({ sink, now: () => t, cooldownMs: 1000 });
    await n.post('a', 'hi');
    t = 1001;
    await n.post('a', 'hi again');
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('cooldown is per-key (different keys can post simultaneously)', async () => {
    const sink = vi.fn();
    const n = new ChatNotifier({ sink, cooldownMs: 1000 });
    await n.post('a', 'hi');
    await n.post('b', 'hi');
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('sink exceptions are swallowed so the caller never crashes', async () => {
    const sink = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const n = new ChatNotifier({ sink, cooldownMs: 1 });
    await n.post('a', 'hi');
    expect(sink).toHaveBeenCalledTimes(1);
    // (no throw escapes the ChatNotifier — vitest asserts this implicitly)
  });

  it('snapshot exposes remaining cooldown per key', async () => {
    let t = 0;
    const n = new ChatNotifier({ sink: () => undefined, now: () => t, cooldownMs: 1000 });
    await n.post('a', 'hi');
    t = 100;
    expect(n.snapshot()).toEqual({ cooldownRemainingByKey: { a: 900 }, trackedKeyCount: 1 });
  });

  it('reset() drops the cooldown so the next post goes through', async () => {
    const sink = vi.fn();
    const n = new ChatNotifier({ sink, cooldownMs: 1000 });
    await n.post('a', 'hi');
    n.reset('a');
    await n.post('a', 'hi');
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('default sink logs to stdout (smoke test — we trust console.log)', async () => {
    const n = new ChatNotifier({ cooldownMs: 0 });
    await n.post('a', 'hi');
    expect(n.snapshot().trackedKeyCount).toBe(1);
  });

  it('discordChannelSink falls back to stdout when client is null', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sink = discordChannelSink(null);
    await sink('a', 'hi');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/standalone/));
    log.mockRestore();
  });

  it('discordChannelSink routes through channel.send when channel exists', async () => {
    const send = vi.fn();
    const client = {
      channels: {
        cache: {
          find: (pred: (c: { type: number; name: string }) => boolean) =>
            pred({ type: 0, name: 'opencatz-control-room' }) ? { send } : undefined,
        },
      },
    };
    const sink = discordChannelSink(client);
    await sink('a', 'hi');
    expect(send).toHaveBeenCalledWith('hi');
  });
});