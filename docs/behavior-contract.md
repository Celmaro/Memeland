# Behavior Contract

This document is the operating contract for the Memeland agent runtime. It
codifies the *guaranteed* behaviors the system must not violate. Every new
feature or wiring change must preserve these invariants.

## 1. Fail-closed security

- A token whose security audit fails, or whose safety gate is not satisfied, is
  **never** executed. Audit failure = refusal, not a soft score.
- The wallet/security/reputation read-path degrades to the plain fail-closed
  voters when reputation inputs (e.g. deployer address) are unavailable. Missing
  evidence never implies a pass.
- Sellability, fill-simulation, cost, governance, and ledger gates are enforced
  on the shared execute path; a gate that is "not configured" reports and stays
  a no-op rather than silently passing.

## 2. Fail-soft wiring

- Every optional block (feeds, sentiment, critic, bytecode, track, tape,
  consensus guards) is wrapped so a failure **never blocks** the core loop.
  The comment "this feature cannot gate execution" is accurate by design.
- External providers (GMGN, Codex, DEXPaprika, DexScreener, price, regime,
  sentiment) fail open to empty/neutral unless the block is a security gate.

## 3. Single append-only ledger

- The decision ledger is the one writer for the proposal → veto → reservation →
  receipt → reconcile state machine. Events are appended as JSONL and are never
  mutated in place. Every realized trade recalibrates exactly once.
- Post-mortem learning feeds only outcomes tied to the opportunity's actual
  evaluation; a profitable-miss is not treated as a reward the bot earned.

## 4. Decision caching semantics

- Sticky decisions re-evaluate on TTL expiry or price movement.
- Immutable one-way-door facts keep the first successfully resolved value.
- Owner dedup collapses one actor's N wallets into one confirmation.

## 5. Swarm consensus guards

- The 10-voter swarm is subject to: a circuit breaker (opens on repeated
  failures), asymmetric-conflict veto, regime floor, calibration, cohort
  demerits, and sticky conviction. A guard can refuse a signal (fail-closed)
  but never fabricates lifecycle events.

## 6. State-machine integrity

- Terminal states have no outgoing edges; invalid transitions are rejected.
- from === to short-circuits; opportunity creation is idempotent.
