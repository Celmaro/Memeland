/**
 * KC5 / Kernel P — ChatNotifier — single source of truth for "post a
 * notification to the operator channel" with built-in cooldown. Replaces the
 * 5 ad-hoc `notifyControlRoom` call sites + the module-level
 * `controlRoomNotifyCooldown` Map in index.ts.
 *
 * Channels are pluggable (Discord client, stdout, webhook, …) via the
 * `sink` callback. Default sink prints to stdout — preserves the current
 * standalone-engine behaviour.
 */

export interface ChatNotifierOptions {
  /** Per-key cooldown window in ms — second post within window is dropped. */
  cooldownMs?: number;
  /**
   * Sink the notification through. Receives the (key, content) on each call
   * that survives the cooldown. Default: console.log with a [NOTIFY] prefix.
   * Errors thrown by the sink are swallowed and logged so a failing
   * transport never crashes the caller.
   */
  sink?: (key: string, content: string) => Promise<void> | void;
  /** Injectable clock — defaults to Date.now. */
  now?: () => number;
}

export interface ChatNotifierSnapshot {
  /** ms remaining before each key will be eligible to post again. */
  cooldownRemainingByKey: Record<string, number>;
  /** Total keys currently tracked (post-then-drop window). */
  trackedKeyCount: number;
}

export class ChatNotifier {
  private readonly cooldownMs: number;
  private sink: (key: string, content: string) => Promise<void> | void;
  private readonly now: () => number;
  private readonly cooldowns = new Map<string, number>();

  constructor(opts: ChatNotifierOptions = {}) {
    this.cooldownMs = opts.cooldownMs ?? 10 * 60 * 1000;
    this.sink =
      opts.sink ??
      ((key, content) => {
        console.log(`[NOTIFY] ${key}: ${content}`);
      });
    this.now = opts.now ?? Date.now;
  }

  /** Post a notification (if the cooldown window has elapsed for this key). */
  public async post(key: string, content: string): Promise<void> {
    const t = this.now();
    const last = this.cooldowns.get(key);
    if (last !== undefined && t - last < this.cooldownMs) return;
    this.cooldowns.set(key, t);
    try {
      await this.sink(key, content);
    } catch (err: unknown) {
      console.warn(
        `[ChatNotifier] sink threw for ${key}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Diagnostic snapshot — how much cooldown remains on each tracked key. */
  public snapshot(): ChatNotifierSnapshot {
    const t = this.now();
    const out: Record<string, number> = {};
    for (const [k, last] of this.cooldowns.entries()) {
      const remaining = this.cooldownMs - (t - last);
      if (remaining > 0) out[k] = remaining;
    }
    return { cooldownRemainingByKey: out, trackedKeyCount: this.cooldowns.size };
  }

  /** Drop the cooldown for a key (force the next post through). */
  public reset(key: string): void {
    this.cooldowns.delete(key);
  }

  /** Swap the sink at runtime (e.g. bind a live Discord client after login). */
  public setSink(sink: (key: string, content: string) => Promise<void> | void): void {
    this.sink = sink;
  }
}

/**
 * Convenience: build a Discord-channel-finder sink from a discord.js client
 * (or any object exposing the same channels.cache surface). When the
 * channel is missing or no client is provided, falls back to stdout — same
 * behaviour as the legacy notifyControlRoom helper.
 */
export function discordChannelSink(
  client: { channels?: { cache?: { find: (pred: (c: { type: number; name: string }) => boolean) => { send?: (content: string) => Promise<unknown> } | undefined } } } | null | undefined,
  channelNames: readonly string[] = ['opencatz-control-room', 'opencat-control-room'],
  textChannelType = 0 // ChannelType.GuildText
): (key: string, content: string) => Promise<void> {
  return async (key, content) => {
    if (!client?.channels?.cache) {
      console.log(`[NOTIFY/standalone] ${key}: ${content}`);
      return;
    }
    const channel = client.channels.cache.find(
      (c) => c.type === textChannelType && channelNames.includes(c.name)
    );
    if (channel?.send) {
      await channel.send(content);
    } else {
      console.log(`[NOTIFY/no-channel] ${key}: ${content}`);
    }
  };
}