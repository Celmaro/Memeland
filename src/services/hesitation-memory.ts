/**
 * PR 11 / Standalone #6 — memanto memory lifecycle and conflict resolution
 * (SRC-155). Ports the lightweight lifecycle/conflict half of memanto into a
 * dependency-free in-memory ledger: memories expire, brief reads only active
 * entries, and flag/clear contradictions resolve by recency then weight.
 *
 * Additive-only: no existing signature is touched.
 */

export type MemoryKind = 'observation' | 'flag' | 'clear';
export type MemoryStatus = 'FLAGGED' | 'CLEARED' | 'NO_MEMORY';

export interface MemoryEntry {
  id: string;
  key: string;
  agent: string;
  kind: MemoryKind;
  claim: string;
  createdAt: number;
  ttlMs: number;
  weight: number;
}

export interface MemoryConflict {
  winnerId: string;
  loserId: string;
  resolvedBy: 'recency' | 'weight';
}

export interface HesitationBrief {
  entries: MemoryEntry[];
  status: MemoryStatus;
  conflicts: MemoryConflict[];
}

export class HesitationMemory {
  private readonly now: () => number;
  private entries: MemoryEntry[] = [];

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  public remember(entry: MemoryEntry): void {
    this.entries.push({ ...entry });
  }

  public brief(key: string): HesitationBrief {
    const entries = this.entries
      .filter((e) => e.key === key && !this.isExpired(e))
      .sort(compareMemory);
    const decisive = entries.filter((e) => e.kind === 'flag' || e.kind === 'clear');
    return {
      entries,
      status:
        decisive.length === 0
          ? 'NO_MEMORY'
          : decisive[0].kind === 'flag'
            ? 'FLAGGED'
            : 'CLEARED',
      conflicts: buildConflicts(decisive),
    };
  }

  public gc(): void {
    this.entries = this.entries.filter((e) => !this.isExpired(e));
  }

  private isExpired(entry: MemoryEntry): boolean {
    return entry.createdAt + entry.ttlMs <= this.now();
  }
}

function compareMemory(a: MemoryEntry, b: MemoryEntry): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  if (a.weight !== b.weight) return b.weight - a.weight;
  return a.id.localeCompare(b.id);
}

function buildConflicts(entries: MemoryEntry[]): MemoryConflict[] {
  const conflicts: MemoryConflict[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const winner = entries[i];
      const loser = entries[j];
      if (winner.kind !== loser.kind) {
        conflicts.push({
          winnerId: winner.id,
          loserId: loser.id,
          resolvedBy: winner.createdAt === loser.createdAt ? 'weight' : 'recency',
        });
      }
    }
  }
  return conflicts;
}
