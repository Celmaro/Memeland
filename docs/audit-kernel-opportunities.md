# Memeland — Kernel Consolidation Audit

**Scope:** find remaining opportunities to implement the *same kind* of kernel
pattern used in `implementation-plan-merge.md` (a small, well-tested module that
centralizes a cross-cutting concern) to reduce complexity while keeping behavior
identical.

**Baseline:** `master @ f7ea2da`, clean tree. `npx tsc --noEmit` clean, **868
tests / 115 files** green.

**Method:** scan for repeated structural patterns across `src/` — hand-rolled
retry/key-rotation loops, hand-rolled atomic JSON persistence, hand-rolled state
machines, provider-interface gaps, and score/confidence conversions — then rate
each candidate **Adopt / Adapt / Study / Skip** and confirm whether the repo
already owns a kernel that absorbs it.

---

## 1. `fetchWithKeyPool` — key-rotation request helper **[Adopt — new kernel]**

**The strongest candidate.** The API-key rotation loop is copy-pasted in **6 files
(8 call sites)**:

| File | Wrapper | Behavior |
|------|---------|----------|
| `src/adapters/gmgn-adapter.ts` | `gmgnRequest` (3× `markFailed`) | rotate on 429 / banned / HTTP err |
| `src/adapters/evm-adapter.ts` | dry-run Uniswap quote loop | rotate on 401/403/429 |
| `src/adapters/krystal-cloud-adapter.ts` | `request` | rotate on auth/rate |
| `src/adapters/opensea-adapter.ts` | `fetchWithKey` | rotate on 401/402/403/429 |
| `src/adapters/x-api-adapter.ts` | inline search loop | rotate on token failure |
| `src/services/goplus-security-service.ts` | inline loop | rotate on 401/403/429 |

Every copy does the same: `while (attempts < maxAttempts) { key = pool.get();
fetch; if ok break; if (401|402|403|429) && size>1 { markFailed; attempts++;
continue } break }`, plus the identical **fail-closed** `if (!key) return null`
when the pool is empty.

**Kernel:** add `fetchWithKeyPool<T>(pool, build, opts)` to
`src/services/api-key-pool.ts` (it already owns `get`/`markFailed`/rotation).
Encapsulates: empty-pool → `null`; loop; `ok` → return; retryable auth/rate
status + `size>1` → `markFailed` + continue; otherwise break. Optional `paced`
and `signal` hooks to absorb gmgn's throttling.

**Value:** removes ~6 copies of a subtle loop whose rotation-reset and
fail-closed semantics are easy to get wrong. Behavior-preserving by
construction. **Risk:** medium (hot adapters). Migrate one caller per commit
behind the existing golden tests; the loop currently produces identical outcomes
so the suite is the safety net.

---

## 2. Consolidate JSON persistence onto `atomic-file-store` **[Adapt — reuse existing kernel]**

`src/storage/atomic-file-store.ts` already ships `AtomicFileStore`,
`atomicWriteJsonSync`, and `readJsonFileSafe` — but only **cron-scheduler** and
**reputation-memory** use them. The same persistence is hand-rolled in **6 more
modules**, two of them re-implementing temp+rename, four not even atomic:

| File | Current write | Correctness gap |
|------|---------------|-----------------|
| `src/services/state-store.ts` | `writeFileSync` + `renameSync` | dups atomic (no gap) |
| `src/services/opportunity-ledger.ts` | `writeFileSync` + `renameSync` | dups atomic (no gap) |
| `src/services/execution-gates.ts` | `writeFileSync` | **not atomic** |
| `src/orchestrator/strategy-engine.ts` | `writeFileSync` | **not atomic** |
| `src/orchestrator/swarm-learning.ts` | `writeFileSync` | **not atomic** |
| `src/services/session-memory.ts` | `writeFileSync` | **not atomic** |

**Kernel:** route each through `atomicWriteJsonSync` (temp+rename) and
`readJsonFileSafe`. For the two already-atomic sites this is pure dedup; for the
four plain-write sites it **adds** crash-safe atomicity — a behavior improvement
that matches the kernel's contract (a torn write never produces a half file),
not a regression. `state-store` keeps its migration + debounce shape; only the
write primitive changes.

**Risk:** low–medium. This also de-risks `opportunity-ledger` (which already
hand-rolls atomicity and would now inherit the tested helper).

---

## 3. Reuse `StateMachine` for opportunity-ledger lifecycle **[Adapt — reuse existing kernel]**

`src/lifecycle/state-machine.ts` provides the generic `StateMachine<S>`
(`canTransitionTo`/`transitionTo`, terminal = empty edges, `from===to` no-op).
`approval-queue-service` already migrated to it.

`src/services/opportunity-ledger.ts` is the **second hand-rolled FSM**: its own
`STATE_TRANSITIONS` map + `transition()` re-implements the same edge rules —
`from===to → no-op`, terminal → reject, invalid edge → reject. The richer
side-effects (returning a `TransitionResult`, emitting events, capturing the
WATCHING admission price) stay.

**Kernel:** build a `StateMachine<OpportunityState>` from the existing
`STATE_TRANSITIONS` and let `transition()` delegate edge-validation to it, keeping
`STATE_TRANSITIONS` as the single source of truth. **Risk:** low; behavior
identical, less duplicated FSM code.

---

## 4. Make `GMGNAdapter` implement `MarketDataProvider` **[Study]**

`src/adapters/market-data-provider.ts` is implemented by **dexscreener-feed,
codex-feed, dexpaprika-feed** — but not by **gmgn-adapter**, the primary
discovery source. The screening agents therefore hard-depend on GMGN's concrete
schema (`GMGNRawToken`), so the "swap the provider" decoupling the feeds already
establish doesn't reach the main path, and the no-single-proprietary-source
(green-label) fallback story stays weaker than it could be.

**Opportunity:** adapt `GMGNAdapter` to the interface so screening consumes
providers uniformly and GMGN becomes swappable for a keyless fallback.
**Risk: HIGH** — `GMGNRawToken` is threaded through ~5 agents and prefilter
helpers; this is a large refactor. Do as a studied/adapt item, not immediately.

---

## 5. Confidence / score normalization helper **[Study]**

`/100` and `*100` confidence conversions appear in **6 files**
(robinhood-screening-agent, nft-screening-agent, position-sizing, swarm-consensus,
approval-execution, approval-queue-service). A `clamp01` / `confidenceToFraction`
helper would remove the off-by-100 class of bug (the same class as the
RSI-`0`-as-falsy bug caught while wiring `technical-indicators`).

**Risk:** low, but each call site's convention (0-1 vs 0-100) must be verified
before unifying — some conversions are intentionally per-domain. Lower priority
than #1/#2/#3.

---

## 6. Deliberately narrow kernels — **Skip**

- **`Result<T,E>` breadth** — currently EVM/quoter only. This is a precision
  kernel, intentionally not forced everywhere. Don't widen.
- **Generic fail-open/fail-closed fetch wrapper** — largely covered by
  `failureValue` in `io/call-policy.ts`; the adapters' bespoke fail-closed
  semantics (return null vs throw) are intentional. Over-abstracting would hurt.
  Revisit only after #1 lands and reveals a cleaner seam.

---

## 7. Do-NOT-Merge guard

The repo now has several ledger/journal concepts that look mergeable but are
semantically distinct — consolidating them would be wrong:
`decision-ledger` (proposal→receipt→reconcile), `opportunity-ledger`
(opportunity lifecycle), `trade-journal-service` (position PnL journal),
`safety-registry.ReplayJournal` (idempotent event replay), `session-memory`
(audit memory). Keep separate; reuse shared kernels (#2 persistence, #3 FSM)
inside them instead of fusing them.

---

## Recommended order

1. **#1 `fetchWithKeyPool`** — new kernel + one-caller-at-a-time migration (highest dup count, behavior-preserving).
2. **#2 atomic persistence** — reuse the existing kernel across the 6 hand-rolled sites (adds atomicity to 4).
3. **#3 StateMachine reuse** — low-risk dedup of the second hand-rolled FSM.
4. **#4/#5** — study/adapt; verify conventions before committing.
