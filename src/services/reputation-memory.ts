/**
 * PR 4 / Kernel A — reputation memory (A1 AEGIS + A2 COPUMP + A24 Million +
 * meme-radar Adapt). The source of truth for "is this deployer known-rugged"
 * that the security/whale voters read from, and the 24h/72h/7d follow-up
 * labels written by the index.ts scheduler.
 *
 * ADOPTIVE: a new module — no existing signature changes (G1). Persisted
 * atomically like safe-config.json; injected io keeps it pure/testable and a
 * corrupt payload is NEVER honored (fail-closed, consistent with
 * SafeConfigRegistry).
 */

import type { RefusalCode } from '../orchestrator/swarm-guards.js';
import path from 'path';
import { atomicWriteJsonSync, readJsonFileSafe } from '../storage/atomic-file-store.js';

// ── Persistence contract (same shape as SafeConfigIO) ──────────────────────
export interface ReputationIO {
  read(): string | null;
  write(payloadJson: string): void;
}

export type LpStatus = 'locked' | 'burned' | 'renounced' | 'none';

/** A1 AEGIS six weighted checks — each flag is a risk the score is docked for. */
export interface AegisSnapshot {
  /** true = mint authority NOT renounced (risk). */
  mintAuthority: boolean;
  /** true = freeze authority set (risk). */
  freezeAuthority: boolean;
  /** % of supply held by the top holder — risky above 20. */
  topHolderConcPct: number;
  bundleDetected: boolean;
  /** risky unless locked/burned. */
  lpStatus: LpStatus;
  metadataFlags: boolean;
}

export interface ReputationAdjustment {
  score: number;
  evidence: string[];
  ref: RefusalCode[];
}

export type FollowUpStatus = 'live' | 'rugged' | 'abandoned';
export type ControlHorizon = '6h' | '24h' | '72h';

// A1 AEGIS weights (sum = 100).
const AEGIS_WEIGHTS = {
  mintAuthority: 20,
  freezeAuthority: 15,
  topHolderConc: 20,
  bundleDetected: 20,
  lpStatus: 15,
  metadataFlags: 10,
} as const;

/** Below this reputation score the adjuster refuses (fail-closed). */
const REPUTATION_FLOOR = 60;
const DEPLOYER_ADJUSTMENT = 25;

// ── COPUMP incident classification (A2, declarative table) ────────────────
export type IncidentCode = 'CLEAN' | 'BUNDLE_PUMP' | 'HONEYPOT' | 'SEQUENTIAL_PUMP';

export interface TokenSnapshot {
  totalSupply: number;
  heldByTopWalletsPct: number;
  holdingWallets: number;
  deployerWalletAgeDays: number;
  deployerHistoryCount: number;
  liquidityLocked: boolean;
  bundleTransactions: number;
}

// ── meme-radar wallet classification (Adapt) ───────────────────────────────
export type WalletTagCode = 'KNOWN_RUGGER' | 'FRESH_WALLET' | 'ESTABLISHED' | 'UNKNOWN';
export interface WalletProfile {
  ageDays: number;
  historyCount: number;
}

interface FollowUpEntry {
  status: FollowUpStatus;
  at: number;
}

interface ReputationState {
  version: number;
  deployers: Record<string, 'good' | 'rugged'>;
  followUps: Record<string, FollowUpEntry>;
  controlGroup: Record<ControlHorizon, number>;
}

const CURRENT_VERSION = 1;
const EMPTY_IO: ReputationIO = { read: () => null, write: () => {} };

export const DEFAULT_REPUTATION_FILE = path.resolve('database', 'reputation-memory.json');

/** File-backed ReputationIO using the atomic-file-store helpers (same pattern as safe-config). */
export function fileReputationIO(filePath: string = DEFAULT_REPUTATION_FILE): ReputationIO {
  return {
    read: () => {
      const parsed = readJsonFileSafe<unknown>(filePath, null);
      return parsed === null || parsed === undefined ? null : JSON.stringify(parsed);
    },
    write: (payloadJson: string) => {
      try {
        atomicWriteJsonSync(filePath, JSON.parse(payloadJson) as unknown);
      } catch (error) {
        console.warn(`[REPUTATION MEMORY] Failed to persist ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

export class ReputationMemory {
  private readonly state: ReputationState;
  private readonly io: ReputationIO;
  private readonly now: () => number;

  constructor(io: ReputationIO = EMPTY_IO, now: () => number = Date.now) {
    this.io = io;
    this.now = now;
    this.state = this.load();
  }

  /** A1 AEGIS six weighted checks + ±25 known-deployer adjustment. */
  public reputationAdjustment(
    _token: string,
    deployer: string,
    snap: AegisSnapshot
  ): ReputationAdjustment {
    let score = 100;
    const evidence: string[] = [];

    if (snap.mintAuthority) {
      score -= AEGIS_WEIGHTS.mintAuthority;
      evidence.push('mintAuthority');
    }
    if (snap.freezeAuthority) {
      score -= AEGIS_WEIGHTS.freezeAuthority;
      evidence.push('freezeAuthority');
    }
    if (snap.topHolderConcPct > 20) {
      score -= AEGIS_WEIGHTS.topHolderConc;
      evidence.push(`topHolderConc ${snap.topHolderConcPct}%`);
    }
    if (snap.bundleDetected) {
      score -= AEGIS_WEIGHTS.bundleDetected;
      evidence.push('bundleDetected');
    }
    if (snap.lpStatus !== 'locked' && snap.lpStatus !== 'burned') {
      score -= AEGIS_WEIGHTS.lpStatus;
      evidence.push('lpStatus');
    }
    if (snap.metadataFlags) {
      score -= AEGIS_WEIGHTS.metadataFlags;
      evidence.push('metadataFlags');
    }

    const known = this.state.deployers[deployer];
    if (known === 'good') {
      score += DEPLOYER_ADJUSTMENT;
      evidence.push('known-good deployer +25');
    } else if (known === 'rugged') {
      score -= DEPLOYER_ADJUSTMENT;
      evidence.push('known-rugged deployer -25');
    }

    score = Math.max(0, Math.min(100, score));
    const ref: RefusalCode[] = score < REPUTATION_FLOOR ? ['LOW_CONFIDENCE'] : [];
    return { score, evidence, ref };
  }

  /** Record a 24h/72h/7d follow-up label for a token. */
  public labelAfterFollowup(token: string, status: FollowUpStatus): void {
    this.state.followUps[token] = { status, at: this.now() };
  }

  public followUpStatus(token: string): FollowUpStatus | null {
    return this.state.followUps[token]?.status ?? null;
  }

  public followUpAgeMs(token: string): number | null {
    const e = this.state.followUps[token];
    return e ? this.now() - e.at : null;
  }

  /** A24 Million control-group baseline — the random-token benchmark. */
  public controlGroupScore(_token: string, horizon: ControlHorizon): number {
    return this.state.controlGroup[horizon];
  }

  public setControlGroupBaseline(horizon: ControlHorizon, value: number): void {
    this.state.controlGroup[horizon] = value;
  }

  public setDeployerKnown(deployer: string, status: 'good' | 'rugged'): void {
    this.state.deployers[deployer] = status;
  }

  public deployerKnown(deployer: string): 'good' | 'rugged' | null {
    return this.state.deployers[deployer] ?? null;
  }

  /** A2 COPUMP incident classification — declarative table. */
  public classifyIncident(token: string, snap: TokenSnapshot): IncidentCode {
    return classifyIncident(token, snap);
  }

  /** meme-radar Adapt — wallet classification. */
  public classifyWallet(wallet: WalletProfile): WalletTagCode {
    return classifyWallet(wallet);
  }

  /** Atomic persistence write. */
  public flush(): void {
    this.io.write(JSON.stringify(this.state, null, 2));
  }

  private load(): ReputationState {
    const fallback: ReputationState = {
      version: CURRENT_VERSION,
      deployers: {},
      followUps: {},
      controlGroup: { '6h': 50, '24h': 50, '72h': 50 },
    };
    const raw = this.io.read();
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as ReputationState;
      if (typeof parsed !== 'object' || parsed === null) return fallback;
      const deployers = parsed.deployers ?? {};
      const followUps = parsed.followUps ?? {};
      const controlGroup = {
        '6h': typeof parsed.controlGroup?.['6h'] === 'number' ? parsed.controlGroup['6h'] : 50,
        '24h': typeof parsed.controlGroup?.['24h'] === 'number' ? parsed.controlGroup['24h'] : 50,
        '72h': typeof parsed.controlGroup?.['72h'] === 'number' ? parsed.controlGroup['72h'] : 50,
      };
      return { version: CURRENT_VERSION, deployers, followUps, controlGroup };
    } catch {
      return fallback; // corrupt — never honor
    }
  }
}

/** A2 COPUMP — declarative incident-classification table. */
export function classifyIncident(_token: string, snap: TokenSnapshot): IncidentCode {
  if (!snap.liquidityLocked) return 'HONEYPOT';
  if (
    snap.bundleTransactions >= 5 &&
    snap.heldByTopWalletsPct >= 50 &&
    snap.holdingWallets < 30
  ) {
    return 'BUNDLE_PUMP';
  }
  if (snap.heldByTopWalletsPct >= 85) return 'SEQUENTIAL_PUMP';
  return 'CLEAN';
}

/** meme-radar Adapt — fail-closed wallet classification. */
export function classifyWallet(w: WalletProfile): WalletTagCode {
  if (w.ageDays < 2) return 'FRESH_WALLET';
  if (w.ageDays >= 180 && w.historyCount >= 20) return 'ESTABLISHED';
  if (w.historyCount >= 6) return 'KNOWN_RUGGER';
  return 'UNKNOWN';
}

/** Live singleton used by the index.ts scheduler writes and voter reads. */
export const globalReputationMemory = new ReputationMemory(fileReputationIO());
