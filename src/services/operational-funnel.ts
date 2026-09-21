export const OPERATIONAL_FUNNEL_STAGES = [
  'sourcesQueried',
  'candidatesDiscovered',
  'candidatesNormalized',
  'candidatesEnriched',
  'candidatesRejectedByGate',
  'signalsEmitted',
  'positionsMonitored',
] as const;

export type OperationalFunnelStage = (typeof OPERATIONAL_FUNNEL_STAGES)[number];
export type OperationalFunnelCounters = Record<OperationalFunnelStage, number>;

const EMPTY_COUNTERS: OperationalFunnelCounters = {
  sourcesQueried: 0,
  candidatesDiscovered: 0,
  candidatesNormalized: 0,
  candidatesEnriched: 0,
  candidatesRejectedByGate: 0,
  signalsEmitted: 0,
  positionsMonitored: 0,
};

export function createOperationalFunnel(base: Partial<OperationalFunnelCounters> = {}): OperationalFunnelCounters {
  return { ...EMPTY_COUNTERS, ...base };
}

export function incrementOperationalFunnel(
  counters: OperationalFunnelCounters,
  stage: OperationalFunnelStage,
  by = 1
): OperationalFunnelCounters {
  return { ...counters, [stage]: counters[stage] + Math.max(0, by) };
}

export function mergeOperationalFunnel(target: OperationalFunnelCounters, source: Partial<OperationalFunnelCounters>): OperationalFunnelCounters {
  const next = { ...target };
  for (const stage of OPERATIONAL_FUNNEL_STAGES) {
    next[stage] += Math.max(0, source[stage] || 0);
  }
  return next;
}

/** Derive the persisted funnel's existing counters into the seven-stage operational view. */
export function funnelCountersFromState(domainFunnels: Record<string, Record<string, number>>): OperationalFunnelCounters {
  const counters = createOperationalFunnel();
  for (const domain of Object.values(domainFunnels)) {
    counters.sourcesQueried += domain.sourcesQueried || domain.sources_queried || 0;
    counters.candidatesDiscovered += domain.candidatesDiscovered || domain.discovered || domain.scanned || 0;
    counters.candidatesNormalized += domain.candidatesNormalized || domain.normalized || domain.prefiltered || 0;
    counters.candidatesEnriched += domain.candidatesEnriched || domain.enriched || 0;
    counters.candidatesRejectedByGate += domain.candidatesRejectedByGate || domain.rejected || 0;
    counters.signalsEmitted += domain.signalsEmitted || domain.fired || 0;
    counters.positionsMonitored += domain.positionsMonitored || 0;
  }
  return counters;
}
