# Opportunity Ledger + Strategist — Design

## Status

**Implemented through build step 4.** The ledger, state machine, Strategist
(steps 1–2), `DISPATCHED` / `MOVED_TO_OPEN` / `POSITION_EXITED` wiring, and the
Post-mortem with swarm-learning feed (steps 3–4) are built and wired into
`src/index.ts`. `ARCHITECTURE_COMPARISON.md` holds the gap analysis this design
closes.

## Goal

Convert Memeland from a *screening engine* into an *opportunity lifecycle
system* by introducing three components:

1. **`OpportunityLedger`** — a durable, append-only record of every opportunity
   from first sighting through outcome.
2. **Lifecycle state machine** — explicit states and allowed transitions,
   owned by the ledger (not scattered across agents/scorecard/Discord/positions).
3. **Strategist** — a per-cycle, deterministic (no LLM) escalation layer that
   decides *which* opportunities the 7-voter swarm scores and *why now*.

All three are pure additions. Existing modules — the 7 voters, consensus gate,
approval ladder, position manager, wallet tracker, scorecard, and
swarm-learning — stay intact and connect to the ledger at a few defined points.

## Design principles

- **Simplicity first.** One flat state enum (not three parallel state families
  from the comparison doc). Append-only events carry the `from/to/reason` audit
  trail; we do not need three state machines to reconstruct history.
- **Reuse, don't duplicate.** The ledger reuses the existing dedupe key
  (`chain:contractAddress` lowercased) and *links* scorecard + approvalOrder ids
  rather than copying their data.
- **No early rejection.** An asset that fails screening is parked with a
  `nextReviewAt`, not forgotten — so it can qualify later without a ranking
  endpoint "rediscovering" it. This is the nursery the comparison doc marked at
  15%.
- **Change-driven, not time-driven.** Only re-score on a meaningful delta, which
  saves LLM/API budget and prevents duplicate signals.
- **Fail-closed.** Unknown chains/addresses never fabricate an identity; a
  transition through an invalid path is rejected.

## 1. Identity

Stable key: **`chain:contractAddress` lowercased** — the same identity the
dedupe already uses in `src/index.ts` (dedup key
`channel:token:contractAddress`). This makes the ledger backward-compatible with
all existing dedupe/cooldown state.

```ts
/** Immutable identity record — created on first sighting (FIRST_SEEN),
 *  never mutated except currentState/stateUpdatedAt/finalOutcome. */
export interface OpportunityIdentity {
  opportunityId: string;       // `${chain}:${contractAddress}` lowercased
  chain: string;
  contractAddress: string;
  symbol?: string;
  firstSeenAt: string;         // ISO, immutable
  firstSeenSource: string;     // 'gmgn:rank' | 'gmgn:trenches' | 'gmgn:hot' | 'trackFeed' | ...
  firstSeenPriceUsd?: number;
  firstSeenMarketCapUsd?: number;
  firstSeenLiquidityUsd?: number;

  // Latest lifecycle position (denormalized for fast lookup)
  currentState: OpportunityState;
  stateUpdatedAt: string;

  // Written once by the Post-mortem when the opportunity closes/attributes.
  finalOutcome?: OpportunityOutcomeReason;
}
```

An asset that appears later through a different source (Gecko trending, smart
money, launchpad event, social mention) attaches to the **same** `opportunityId`.
The identity graph is a later extension; for now the record holds the hook
(`opportunityId`/chain/address) a graph can be built on.

## 2. Observations

Append-only snapshots, recorded only when something meaningful changed
(price/liquidity/volume/smart-money delta above a per-source epsilon). This is
the raw material for change-driven escalation and future matched-cohort
queries.

```ts
export interface OpportunityObservation {
  id: string;
  opportunityId: string;
  observedAt: string;
  source: string;
  priceUsd?: number;
  volume1hUsd?: number;
  volume24hUsd?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  smartWalletsBuying?: number;   // trackAcc smartWalletCount
  totalBuyUsd?: number;
  totalSellUsd?: number;
  rugRatio?: number;
  top10HolderRate?: number;
  creatorClose?: boolean;
  extra?: Record<string, unknown>;
}
```

## 3. Lifecycle state machine

One flat enum (MVP). The audit trail lives in `OpportunityEvent.from/to`, so a
single enum is enough.

```ts
export type OpportunityState =
  | 'FIRST_SEEN'
  | 'IDENTITY_RESOLVED'
  | 'RISK_PENDING'
  | 'RISK_REJECTED'
  | 'WATCHING'            // nursery — parked, re-reviewed on nextReviewAt
  | 'ACCELERATING'
  | 'RESEARCH_READY'
  | 'WATCH_TRIGGER'
  | 'READY_SMALL_BET'
  | 'APPROVAL_PENDING'
  | 'APPROVED'
  | 'OPEN'
  | 'REDUCE'
  | 'EXIT_TRIGGERED'
  | 'EXITED'
  | 'MISSED'
  | 'CORRECT_REJECTION'   // terminal attribution outcome
  | 'EXPIRED';
```

### Allowed transitions (validated by `transition()`)

```text
FIRST_SEEN        -> IDENTITY_RESOLVED | RISK_PENDING | RISK_REJECTED
IDENTITY_RESOLVED -> RISK_PENDING | RISK_REJECTED
RISK_PENDING      -> WATCHING | RISK_REJECTED
RISK_REJECTED     -> WATCHING                   // parking, nextReviewAt later
WATCHING          -> ACCELERATING | RISK_REJECTED | EXPIRED
ACCELERATING      -> WATCH_TRIGGER | WATCHING
RESEARCH_READY    -> WATCH_TRIGGER | WATCHING
WATCH_TRIGGER     -> READY_SMALL_BET | WATCHING
READY_SMALL_BET   -> APPROVAL_PENDING | EXPIRED
APPROVAL_PENDING  -> APPROVED | EXITED | EXPIRED
APPROVED          -> OPEN | EXITED
OPEN              -> REDUCE | EXIT_TRIGGERED | EXITED
REDUCE            -> OPEN | EXIT_TRIGGERED | EXITED
EXIT_TRIGGERED    -> EXITED
EXITED            -> (terminal) finalOutcome
MISSED            -> (terminal) finalOutcome
CORRECT_REJECTION -> (terminal)
EXPIRED           -> (terminal)
```

Any other edge is rejected by the ledger (fail-closed). Terminal states receive
a `finalOutcome` from the Post-mortem.

## 4. Events

Append-only audit trail — reconstructs every state transition and decision.

```ts
export type OpportunityEventType =
  | 'FIRST_SEEN'
  | 'OBSERVED'           // meaningful delta recorded (may not change state)
  | 'IDENTITY_RESOLVED'
  | 'RISK_PASSED'
  | 'RISK_REJECTED'
  | 'NURSERY_ADMITTED'
  | 'ESCALATED'          // WATCHING -> ACCELERATING
  | 'RESEARCH_BUDGET_USED'
  | 'TRIGGER_FIRED'      // WATCH_TRIGGER -> READY_SMALL_BET
  | 'APPROVAL_PENDING'
  | 'OPERATOR_REJECTED'
  | 'DISPATCHED'         // signal fired to Discord; links scorecard + approvalOrder
  | 'MOVED_TO_OPEN'      // position opened
  | 'POSITION_EXITED'
  | 'MISSED'
  | 'ATTRIBUTED';        // Post-mortem wrote finalOutcome

export interface OpportunityEvent {
  id: string;
  opportunityId: string;
  type: OpportunityEventType;
  from?: OpportunityState;
  to?: OpportunityState;
  reason: string;         // e.g. 'liquidity crossed 20k', 'consensus 82'
  data?: Record<string, unknown>;
  at: string;             // ISO
}
```

## 5. Miss attribution

Stored once as `finalOutcome` on the identity and set by the Post-mortem.

```ts
export type OpportunityOutcomeReason =
  | 'NOT_DISCOVERED'
  | 'DISCOVERED_LATE'
  | 'IDENTITY_UNRESOLVED'
  | 'RISK_REJECTED'
  | 'LIQUIDITY_REJECTED'
  | 'VOLUME_REJECTED'
  | 'CONSENSUS_REJECTED'
  | 'RESEARCH_BUDGET_EXHAUSTED'
  | 'NOT_NOTIFIED'
  | 'NOT_APPROVED'
  | 'EXECUTION_FAILED'
  | 'POSITION_EXIT_FAILED'
  | 'PROFITABLE_MISS'
  | 'CORRECT_REJECTION';
```

This fixes the funnel gap: today the funnel counts only
`scanned / consensus / fired / executed` (`src/index.ts`), which drops *why*
things were rejected. Recording `RISK_REJECTED`, `CONSENSUS_REJECTED`,
`NOT_APPROVED`, `EXECUTION_FAILED` per opportunity gives the answer to "was the
opportunity undiscovered, filtered, not approved, or mishandled after entry?"

## 6. Strategist — first escalation rules

Deterministic, per-cycle, no new LLM machinery. It answers "which opportunities
to score and why now".

```text
ingest raw sightings (gmgn rank/trenches/hot + track feed)
  -> ledger.ensureOpportunity()      // create identity + FIRST_SEEN, or
                                      // append observation on meaningful delta

ESCALATION RULES (state transitions based on diff, not every 5-min cycle):
  FIRST_SEEN      -- prefilter pass                  --> WATCHING   (admit to nursery)
  WATCHING        -- liquidity>20k
                    OR smartWalletsBuying doubled
                    OR vol24h>100k                   --> ACCELERATING
  ACCELERATING    -- trigger: isGraduated
                    OR >1 smart full-close
                    OR price ATH                     --> WATCH_TRIGGER
  WATCH_TRIGGER   -- run swarm once
                    --> confidence>=80 ? READY_SMALL_BET : stay WATCHING
  READY_SMALL_BET -- enqueue (existing approval ladder) --> APPROVAL_PENDING
```

- **Change-driven**: opportunities that only got price/noise updates stay in
  `WATCHING` with a refreshed observation — they are not re-scored, saving
  budget and preventing duplicate signals.
- **Parking**: `RISK_REJECTED` / `LIQUIDITY_REJECTED` / `VOLUME_REJECTED` set a
  `nextReviewAt`; the Strategist re-admits them to `WATCHING` when their metrics
  recover. No hard deletion except explicit `EXPIRED`.
- **Tie-in**: when the Strategist schedules a swarm run and the ≥80 consensus
  passes, `src/index.ts` dispatches as today; the ledger also records a
  `DISPATCHED` event linking `scorecardId` + `approvalOrderId`.

## 7. Integration points (minimal diff)

| File | Change |
|---|---|
| `src/services/opportunity-ledger.ts` (new) | `OpportunityIdentity`, `OpportunityObservation`, `OpportunityEvent`, `transition()`, persistence per `StateStore` pattern |
| `src/agents/meme-robinhood/robinhood-screening-agent.ts` | Keep 7-voter scoring + thesis; defer "which + why now" to the Strategist |
| `src/orchestrator/swarm-consensus.ts` | Untouched — still the ≥80 gate |
| `src/index.ts` (dispatch loop ~`:401`) | On fire: also emit `DISPATCHED` event linking `scorecardId`/`approvalOrderId` |
| `src/position/position-manager.ts` | Emit `MOVED_TO_OPEN` on `addPosition`, `POSITION_EXITED` on remove/exit (`stopLossPct` path already exists) |
| `src/orchestrator/swarm-learning.ts` | Post-mortem reads `closedUnattributed()` opportunities, sets `finalOutcome`, then feeds `recalibrateWeights()` |
| `database/opencatz_state.json` | No schema break — ledger is a separate file; state `version` stays `2` |

## 8. Persistence & safety

- Reuses the `StateStore` pattern in `src/services/state-store.ts`: JSON file
  under `database/`, debounced save, atomic write (`writeFileSync` to `.tmp`
  then `renameSync`), and `ensureLatestFields()` backfill for forward
  compatibility.
- Ledger file: `database/opportunity_ledger.json`, capped like `signalLedger`
  (10k events → prune to last 5k).
- `transition()` validates every edge; `ensureOpportunity()` is idempotent by
  identity key; every write is fail-closed.

## 9. MVP cut (explicitly out of scope)

- No identity graph (pools/projects/wallets/teams) yet — `opportunityId` is the
  hook for a later graph.
- No pooled research budgets — just per-opportunity `nextReviewAt` throttling.
- No matched-cohort code in this step — the ledger's
  chain/state/liquidity/window/source fields make cohorts a later query, not new
  storage.

## Build order

1. `OpportunityLedger` service + state machine + persistence (TDD, mirrors
   `StateStore`).
2. Strategist ingestion + the three escalation rules above.
3. Wire `DISPATCHED` / `MOVED_TO_OPEN` / `POSITION_EXITED` events.
4. Post-mortem reads closed opportunities, writes `finalOutcome`, feeds
   `swarm-learning.ts`.
