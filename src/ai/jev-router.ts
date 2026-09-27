/**
 * P5.2 — Jev router. Shadow-mode decision layer: when enabled, calls the
 * TypeSafe System One API with a compact feature snapshot and validates the
 * typed output; any failure falls back to the swarm confidence. Jev never
 * executes and never overrides deterministic gates.
 */

import { validateJevOutput, type JevOutput } from './jev-schema.js';

export interface JevClient {
  call(state: unknown): Promise<JevOutput>;
}

export interface JevRouterOptions {
  /** Swarm confidence fallback (0-100). */
  swarmConfidence: number;
  /** Optional Jev client; absent = always swarm (feature disabled). */
  client?: JevClient;
}

export interface JevDecision {
  source: 'jev' | 'swarm';
  confidence: number;
  regime?: JevOutput['regime'];
  nextAction?: JevOutput['nextAction'];
  /** Present when Jev actually decided. */
  raw?: JevOutput;
}

export class JevRouter {
  private readonly client?: JevClient;
  private readonly swarmConfidence: number;

  constructor(opts: JevRouterOptions) {
    this.client = opts.client;
    this.swarmConfidence = opts.swarmConfidence;
  }

  public enabled(): boolean {
    return process.env.JEV_ENABLED === 'true' && !!this.client;
  }

  public async decide(state: unknown): Promise<JevDecision> {
    if (!this.enabled() || !this.client) {
      return { source: 'swarm', confidence: this.swarmConfidence };
    }
    try {
      const raw = await this.client.call(state);
      const v = validateJevOutput(raw);
      if (!v.ok) {
        console.warn(`[JEV] invalid output (${v.reason}) — swarm fallback`);
        return { source: 'swarm', confidence: this.swarmConfidence };
      }
      return {
        source: 'jev',
        confidence: Math.round(raw.continuationProb * 100),
        regime: raw.regime,
        nextAction: raw.nextAction,
        raw,
      };
    } catch (err: any) {
      console.warn(`[JEV] call failed (${err.message}) — swarm fallback`);
      return { source: 'swarm', confidence: this.swarmConfidence };
    }
  }
}
