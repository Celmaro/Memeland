# Implementation Plan — Provider-Fabric: Observations, Hint Gate, Final Snapshot

Status: DRAFT · Grounded at HEAD `ddedf3c` · Follows the established safe-phase pattern
(each phase: tests → tsc → full suite → commit → push → deploy → verify safety keys).

## 0. Grounding (verified facts, not assumptions)

| # | Fact | Evidence |
|---|---|---|
| F1 | `DiscoveryCoordinator.discoverAll()` returns **only the merged candidate list**. Per-source observations are discarded at merge (later source overwrites earlier). | `src/discovery/candidate-emitter.ts:106-148` — single `merged` Map, returns `[...merged.values()]`. |
| F2 | `CandidateRegistry.observe(obs: DiscoveryObservation)` and the full per-source model (`firstSeen`, `latencyMs`, `coverage`, `dupRate`, `spend`, `falsePositive`, `firstSource`) **already exist** — but the agent feeds it **one observation per merged candidate**, tagged with `t.discoveredBy ?? t.source` (i.e. only the last source). Per-source coverage/latency answers are therefore unanswerable today. | `src/discovery/discovery-registry.ts:29-115`; `robinhood-screening-agent.ts:955-965`. |
| F3 | `MarketToken` carries `pairAddress` + `dex`, but `normalizeDexToken()` drops both — `GMGNRawToken` has **no pool identity**. The DEX/pair evidence dies at normalization. | `market-data-provider.ts:27-28`; `dexscreener-feed.ts:146`; `robinhood-discovery.ts:49-87` (no pair/dex in output). |
| F4 | `globalHintRegistry` is **dead code in the live path** (only referenced in its own test). FOMO/GMGN go straight into the coordinator as normal emitters — the documented hint pipeline (`candidate-hints.ts`) is not enforced. | `candidate-hints.ts:153`; `candidate-hints.test.ts:2`; `robinhood-screening-agent.ts:276` (`reg('fomo', …)`). |
| F5 | The FeatureSnapshot is built **before** finalist security work completes: `security: { sellable: true }` is written while the comment admits sellability is proven later; actual `sellability.check()`, bytecode scan, CoinStats run after the snapshot. | `robinhood-screening-agent.ts:1251-1275` vs `1318-1347`. |
| F6 | The review's #1 concern (red CI, DexScreener test) is **already fixed at HEAD** — `robinhood-agent-additional-sources.test.ts` passes 4/4 (fixed by `c5d165f`, `88db13d`). Not a composition-root regression; was a cross-test quota leak. | Local run on `ddedf3c`. |
| F7 | `DiscoverySource` union lacks `tape`, `track`, `ws-tape` even though `DISCOVERY_PRIORITY` includes them; `normalizeTapeWindow` tags tape rows as source `dexscreener`. Observation source must be the **emitter id**, not the token's normalized source tag. | `discovery-registry.ts:11`; `DISCOVERY_PRIORITY` in `candidate-emitter.ts:45-58`; `robinhood-discovery.ts:44`. |

## 1. Scope decisions

**In scope (next 3 phases):**
- P5 · Observation sink + pool identity (fixes F1/F2/F3) — the foundational evidence fix.
- P6 · FOMO/GMGN → hint gate (fixes F4).
- P7 · Final FeatureSnapshot after security (fixes F5).

**Held (separate roadmap items, NOT started now):**
- Postgres durability layer at the observation boundary (ledgers stay behind their APIs).
- Redis for ephemeral queues/locks/cache.
- `ResearchCoordinator` extraction.
- Walk-forward dataset unification, real calibration model.

Rationale for holding: P5's observation sink is the prerequisite for every downstream DB/ledger
improvement; starting storage before P5 would migrate from the same lossy point the review flagged.

---

## 2. Phase 5 — Observation sink + pool identity

Goal: **never destroy evidence the merged candidate no longer needs.** Per-source sightings
survive in `CandidateRegistry`; DEX/pair identity survives on the token.

### 2.1 Observation sink

Change `discoverAll()` to also emit per-source observations **before** merge:

```
discoverAll(chain, opts): Promise<{ candidates: GMGNRawToken[]; observations: DiscoveryObservation[] }>
```

- Per emitter (and per `extras` entry), for each returned token, push
  `{ chain, tokenAddress: t.address, source: <emitter.id>, at: <collect time> }`.
  - `source` = the **emitter id** (or `allowlistSource`), NOT the token's `source` tag (F7).
  - `at` = `Date.now()` captured when that emitter ran, so first-seen/latency ordering is honest
    across sources even when the agent calls in a loop.
  - `costCredits` forwarded when the emitter exposes it (spend metrics keep working).
- Fail-soft semantics unchanged: a throwing emitter contributes zero observations; cooldown
  registration stays inside each emitter's `discover()` (Phase 3 decision — do not re-gate in the
  coordinator).
- Keep `discoverAll` behavior identical for candidates (same merge/overlay/priority); only the
  return shape changes.

Files:
- `src/discovery/candidate-emitter.ts` — return `{ candidates, observations }`; add internal
  `collectObservations` helper; extend `DiscoverAllOptions` with optional `observeAt?: () => number`
  for deterministic tests.
- `src/discovery/candidate-emitter.test.ts` — update 4 tests to the new shape; add 3 tests:
  1. observations include **every source that saw a token** (not just the merge winner);
  2. observation `source` uses the emitter id, distinct from token `source` tag (tape case);
  3. throwing emitter contributes no observations but candidates from others still present.
- `src/agents/meme-robinhood/robinhood-screening-agent.ts` (line ~949) — destructure
  `{ candidates, observations }`; replace the survivor-only registry feed (F2) with:
  ```ts
  for (const obs of observations) globalCandidateRegistry.observe(obs);
  ```
  (keep `scannedBySource` on the merged candidates for pass telemetry).

### 2.2 Pool identity carry

- Add optional `pairAddress?: string` and `dex?: string` to `GMGNRawToken`
  (`src/adapters/gmgn-adapter.ts`).
- `normalizeDexToken()` (`robinhood-discovery.ts:49`) threads
  `pairAddress: t.pairAddress, dex: t.dex` into the output (F3).
- Confirm each feed that sets `pairAddress`/`dex` on `MarketToken` flows through untouched
  (`dexscreener-feed.ts:146`, `cmc-dex-feed.ts:125`, `dexpaprika-feed.ts:181`, `ankr-discovery-feed.ts:151`).

Tests:
- `tests/wave1-rate-limit.test.ts` / `src/agents/meme-robinhood/robinhood-discovery.test.ts` (if present):
  normalization retains pair/dex from a MarketToken with them set.
- New: merged candidate keeps the **last writer's** pair/dex (documented override semantics).

### 2.3 Phase 5 verification

- `npx tsc --noEmit` clean.
- Targeted: `candidate-emitter.test.ts`, registry tests, `robinhood-agent.test.ts` (29/29).
- Full suite: expect 1139/1140+new, with only the known pre-existing flakes:
  - `robinhood-agent-additional-sources.test.ts` (c)→(d) cooldown ordering (may pass on a good run),
  - `token-audit-service.test.ts` network/shared-cache.
- Commit → push → deploy → confirm RUNNING → confirm safety keys (`DRY_RUN=true`,
  `AUTO_EXECUTE_ENABLED=false`, `OPERATOR_APPROVAL_REQUIRED=true`) untouched.

---

## 3. Phase 6 — FOMO/GMGN as hint sources (enforce the documented pipeline)

Goal: make `candidate-hints.ts` the live path for recall-only sources (F4). On-chain/RPC/WS
sources remain direct introducers; FOMO/GMGN rows must survive an on-chain existence check
before entering the candidate universe.

### 3.1 Wiring

```
FOMO board / GMGN rows
        ↓
HintRegistry.record(hint)      (cheap, dedup, no registry touch)
        ↓
HintRegistry.drain(verify)     (chain-aware existence oracle)
        ↓  only exists:true
candidate universe (coordinator)
```

- Compose the verify callback with `chainAwareVerifier` (`candidate-hints.ts:142`) + real
  existence oracles already owned by the system:
  - EVM: `eth_getCode` / `eth_call` over the RPC failover pool (`rpc-verify.ts`).
  - Sol: `getTokenLargestAccounts` over the Sol RPC pool (P0 slice already drains the WS tape
    for mint existence).
- Feed `globalHintRegistry.record(...)` from `collectFomoCandidates` (agent) and the GMGN overlay
  rows; feed the promoted (verified) results into the coordinator **in place of** the raw rows.
- Keep fail-closed (verify failure = not promotable) but **fail-open at the transport level**:
  if the RPC oracle itself is down (classified transient/quota), do NOT silently starve the funnel —
  demote to the prior behavior for that pass and register cooldown (per `source-quota.ts`).
- Extend `DiscoverySource` union (`discovery-registry.ts:11`) with `tape`/`track`/`ws-tape` so the
  P5 observation sink can tag all `DISCOVERY_PRIORITY` emitters (F7).

Files:
- `src/discovery/candidate-hints.ts` — minor: expose `recordBatch`/`drain` usage contract, add
  `promoted()` stats if needed.
- `src/agents/meme-robinhood/robinhood-screening-agent.ts` — route FOMO + GMGN rows through the
  hint registry before the coordinator.
- `src/services/onchain/rpc-verify.ts` — export the existence-check primitives if not already.
- New test file `src/discovery/hint-gate.test.ts`:
  1. FOMO row that fails existence → NOT promoted;
  2. FOMO row that passes → promoted, `discoveredBy` preserved;
  3. transport-down oracle → fail-open (rows flow, cooldown registered);
  4. GMGN overlay stays enrichment-only for addresses the coordinator already has.

Risk notes:
- This adds one RPC existence call per unique hint — gate batching behind the same quota/cooldown
  machinery. Verify-only-if-not-already-canonical (coordinator-known addresses skip the check).
- Behavior change is observable: some FOMO rows previously candidate-eligible now require
  on-chain existence. Test against fixtures; deploy with the same env gates.

---

## 4. Phase 7 — Final FeatureSnapshot after security evidence

Goal: the snapshot is truly **everything known at decision time** (F5).

- Move the `buildFeatureSnapshot(...)` call (agent `~1251`) to **after** the security/risk block
  (`~1347`): sellability result, security penalties, CoinStats penalties, bytecode/anti-fooling
  findings, RPC verify status all feed the snapshot's `security` facet.
- Replace the placeholder `security: { sellable: true }` with the real final values.
- Extend provenance from a single `{ source, fetchedAt }` to per-facet attribution where the
  enrichment already knows the origin (price→DexScreener, flow→DEXPaprika, security→GoPlus,
  entity→Arkham, momentum→GMGN/Gecko). Keep the `Object.freeze` immutability contract.
- No schema change to consumers: payload keeps `featureSnapshot`; content is now final + richer.

Tests:
- Snapshot reflects a **failing** sellability check (previously it would claim `sellable:true`).
- Snapshot timestamps/provenance exist for a candidate whose price came from a different source
  than its security evidence.

---

## 5. Held roadmap (explicitly NOT in this implementation pass)

| Item | Entry condition |
|---|---|
| Postgres at the observation boundary | P5 shipped and collecting real observations for ≥1 cycle |
| Ledgers (opportunity/decision/paper) migrated behind their APIs | Postgres layer exists |
| Redis ephemeral queues/locks/cache | Research/enrichment call volume justifies it |
| `ResearchCoordinator` extraction | Post-consensus cost/priority logic becomes measurable |
| Walk-forward unified datasets + real calibration | Labeled outcome history is durable |

---

## 6. Per-phase exit checklist (each phase, in order)

1. `npx tsc --noEmit` clean.
2. Targeted new/changed tests pass; affected agent tests pass.
3. Full suite: no NEW failures beyond the two known flakes (documented in §2.3).
4. Commit with a `Phase N:` summary; `git push origin master` (SSH remote configured).
5. `zeabur deploy -i=false --service-id 6aafa042477bfd0030146665 --environment-id 6aafa03284965b61ae2e85f7 --project-id 6aafa032477bfd0030146662`.
6. `service get` → RUNNING.
7. `variable list` → DRY_RUN / AUTO_EXECUTE_ENABLED / OPERATOR_APPROVAL_REQUIRED intact.
8. No `.env`/key material added to git.
