/**
 * #1 — Point-in-time FeatureSnapshot (Memeland 2.0 evidence store).
 *
 * An IMMUTABLE, timestamped capture of every feature group a decision may use,
 * each value tagged with its source + observation time. The decisive rule:
 * **a decision may only use a snapshot that existed at the decision timestamp** —
 * no future information. Snapshots are frozen on build so a late observation
 * can never mutate the record a decision was based on.
 *
 * This replaces the flat "one blended confidence" with a provenance-aware,
 * decision-time-consistent view that the voter swarm / Jev / ML consume.
 */

export interface ProvenancedValue<T> {
  value: T;
  /** Which provider / code path produced this observation. */
  source: string;
  /** Epoch ms when the value was observed. */
  observedAt: number;
  /** Epoch ms when the value goes stale (optional). */
  validUntil?: number;
}

export interface FeatureGroup {
  market?: {
    priceUsd: ProvenancedValue<number>;
    liquidityUsd: ProvenancedValue<number>;
    volume24hUsd: ProvenancedValue<number>;
    [k: string]: ProvenancedValue<number>;
  };
  flow?: {
    buyUsd1h: ProvenancedValue<number>;
    sellUsd1h: ProvenancedValue<number>;
    netFlowUsd1h?: ProvenancedValue<number>;
    [k: string]: ProvenancedValue<number> | undefined;
  };
  security?: {
    sellable: ProvenancedValue<boolean>;
    honeypot?: ProvenancedValue<boolean>;
    rugRatio?: ProvenancedValue<number>;
  };
  momentum?: {
    change1hPct?: ProvenancedValue<number>;
    change5mPct?: ProvenancedValue<number>;
    mlProb?: ProvenancedValue<number>;
  };
  smartMoney?: {
    smartDegenCount?: ProvenancedValue<number>;
    kolCount?: ProvenancedValue<number>;
  };
  deployer?: {
    quality?: ProvenancedValue<number>;
    rugRate?: ProvenancedValue<number>;
  };
}

export interface FeatureSnapshot {
  snapshotId: string;
  candidateId: string;
  /** Decision-time timestamp (epoch ms). Nothing later may enter this snapshot. */
  timestamp: number;
  strategyVersion?: string;
  modelVersion?: string;
  /** 0..1 completeness of the fields that rendered. */
  dataQuality: number;
  /** Provenance: which source fed this snapshot and when. */
  source: { name: string; fetchedAt: number };
  market: FeatureGroup['market'];
  flow: FeatureGroup['flow'];
  security: FeatureGroup['security'];
  momentum: FeatureGroup['momentum'];
  smartMoney: FeatureGroup['smartMoney'];
  deployer: FeatureGroup['deployer'];
  evidenceLineage: Array<{ group: string; field: string; source: string; observedAt: number }>;
}

type SnapshotInput = {
  candidateId: string;
  timestamp: number;
  strategyVersion?: string;
  modelVersion?: string;
  source: { name: string; fetchedAt: number };
  market?: Partial<Record<string, number>>;
  flow?: Partial<Record<string, number>>;
  security?: Partial<Record<string, boolean>>;
  momentum?: Partial<Record<string, number>>;
  smartMoney?: Partial<Record<string, number>>;
  deployer?: Partial<Record<string, number>>;
  /**
   * Phase 7 — per-facet provenance override. Keyed by group name; each value
   * supplies THAT group's source+time (price→DexScreener, flow→DEXPaprika,
   * security→GoPlus, etc). Groups missing here fall back to `source`. This is
   * what lets a multi-provider finalist carry honest lineage instead of one
   * coarse `{source, fetchedAt}` stamped across every field.
   */
  provenance?: Partial<Record<keyof FeatureGroup, { name: string; fetchedAt: number }>>;
};

const prov = <T>(v: T, source: string, observedAt: number): ProvenancedValue<T> => {
  const p: ProvenancedValue<T> = { value: v, source, observedAt };
  return p;
};

const GROUP_FIELDS: Array<keyof FeatureGroup> = ['market', 'flow', 'security', 'momentum', 'smartMoney', 'deployer'];
const EXPECTED_COUNTS: Record<string, number> = {
  market: 3, flow: 2, security: 1, momentum: 1, smartMoney: 2, deployer: 2,
};

function freezeGroup(group: FeatureGroup): FeatureGroup {
  // Deep-freeze so no late observation can mutate the decision-time record.
  const out: FeatureGroup = {};
  for (const g of GROUP_FIELDS) {
    const src = group[g];
    if (!src) continue;
    const frozen: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      frozen[k] = Object.freeze(v);
    }
    out[g] = Object.freeze(frozen) as never;
  }
  return Object.freeze(out);
}

/**
 * Build an immutable, provenance-tagged point-in-time snapshot. Every numeric/
 * boolean input becomes a ProvenancedValue{value, source, observedAt}; the
 * resulting groups are deep-frozen so nothing can retro-edit them.
 */
export function buildFeatureSnapshot(input: SnapshotInput): FeatureSnapshot {
  const src = input.source.name;
  const t = input.source.fetchedAt;
  // Phase 7 — per-facet source/time override; falls back to the global source.
  const provFor = (g: keyof FeatureGroup): { name: string; fetchedAt: number } => {
    const p = input.provenance?.[g];
    return p ? { name: p.name, fetchedAt: p.fetchedAt } : { name: src, fetchedAt: t };
  };

  const group = (entries?: Partial<Record<string, number>>, g: keyof FeatureGroup = 'market'): FeatureGroup['market'] | undefined => {
    if (!entries) return undefined;
    const { name, fetchedAt } = provFor(g);
    const out: Record<string, ProvenancedValue<number>> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = prov(v, name, fetchedAt);
    }
    return Object.keys(out).length > 0 ? out as never : undefined;
  };
  const secGroup = (entries?: Partial<Record<string, boolean>>, g: keyof FeatureGroup = 'security'): FeatureGroup['security'] | undefined => {
    if (!entries) return undefined;
    const { name, fetchedAt } = provFor(g);
    const out: Record<string, ProvenancedValue<boolean>> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v === 'boolean') out[k] = prov(v, name, fetchedAt);
    }
    return Object.keys(out).length > 0 ? out as never : undefined;
  };

  const featureGroups: FeatureGroup = {
    market: group(input.market, 'market') as FeatureGroup['market'],
    flow: group(input.flow, 'flow') as FeatureGroup['flow'],
    security: secGroup(input.security, 'security') as FeatureGroup['security'],
    momentum: group(input.momentum, 'momentum') as FeatureGroup['momentum'],
    smartMoney: group(input.smartMoney, 'smartMoney') as FeatureGroup['smartMoney'],
    deployer: group(input.deployer, 'deployer') as FeatureGroup['deployer'],
  };
  // Deep-freeze the groups so a late observation can never mutate the
  // decision-time record (point-in-time immutability).
  const frozenGroups = freezeGroup(featureGroups);

  // Data-quality = fraction of expected fields that rendered, averaged across
  // the groups the caller actually populated.
  const populated = GROUP_FIELDS.filter((g) => frozenGroups[g] !== undefined);
  const dq =
    populated.length === 0
      ? 0
      : populated.reduce((acc, g) => {
          const n = Object.keys(frozenGroups[g]!).length;
          const expected = EXPECTED_COUNTS[g] ?? 1;
          return acc + Math.min(1, n / expected);
        }, 0) / populated.length;

  const evidenceLineage: FeatureSnapshot['evidenceLineage'] = [];
  for (const g of populated) {
    const grp = frozenGroups[g]!;
    for (const [field, pv] of Object.entries(grp)) {
      const v = pv as ProvenancedValue<unknown>;
      evidenceLineage.push({ group: g, field, source: v.source, observedAt: v.observedAt });
    }
  }

  const snap: FeatureSnapshot = {
    snapshotId: `SNAP_${input.timestamp}_${Math.random().toString(36).substring(2, 7)}`,
    candidateId: input.candidateId,
    timestamp: input.timestamp,
    strategyVersion: input.strategyVersion,
    modelVersion: input.modelVersion,
    dataQuality: Math.round(dq * 100) / 100,
    source: { ...input.source },
    market: frozenGroups.market,
    flow: frozenGroups.flow,
    security: frozenGroups.security,
    momentum: frozenGroups.momentum,
    smartMoney: frozenGroups.smartMoney,
    deployer: frozenGroups.deployer,
    evidenceLineage,
  };
  return Object.freeze(snap);
}
