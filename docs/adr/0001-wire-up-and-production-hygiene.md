# ADR-0001: Wire-up pass (W-01…W-11) and production hygiene

**Status:** Accepted · **Date:** 2026-09-22

## Context

Audits against the consolidated merge report showed several kernels and guards
were already built but not wired into the live path. This ADR records the wiring
decisions and the identity/ops hygiene changes that close those gaps.

## Decisions

- **W-01** — `swarm-guards` wired into `swarm-consensus` (additive). The plain
  no-guard path is unchanged; guards only add refusal and outcome tracking.
- **W-02** — Kernel A reputation read-path (`reputationContextFromToken`) feeds
  the security and wallet voters in the screening swarm; fails back to the plain
  fail-closed voters when no deployer address is present.
- **W-03** — `globalDecisionCache` created; the cache-aware quant and
  convergence voters are used in the swarm (sticky conviction + owner dedup).
- **W-04** — `gateSellability` passed into `executeMemeBuy`; until a Quoter
  transport is configured it reports "not enforced" (no-op).
- **W-05** — `globalDecisionLedger` now appends JSONL to
  `database/decision-ledger.jsonl` via `fileDecisionLedgerIO`.
- **W-07** — `src/orchestrator/incident-classifier.ts` created as the canonical
  re-export home for `classifyIncident` (logic stays in reputation-memory).
- **W-08** — `CodexFeed` and `DexpaprikaFeed` injected into the screening agent
  and collected alongside DexScreener; each is env-gated
  (`CODEX_FEED_ENABLED` / `DEXPAPRIKA_FEED_ENABLED`), fail-open empty by default.
- **W-09** — package bin gains `memeland` as the primary alias; the pm2 deploy
  process is named `memeland-agent` (legacy `opencatz/opencat` names kept as
  aliases and cleaned up on deploy).
- **W-10** — GitHub Actions CI added (`vitest`, `tsc --noEmit`, `npm run build`).
- **W-11** — `docs/behavior-contract.md` and this ADR document the invariants.

## Ops notes

- **Run:** `npm start` (built) or `npm run dev` (tsx watch). Deploy via
  `npm run deploy` → pm2 `memeland-agent`.
- **Env gates:** feeds (`*_FEED_ENABLED`), voter swarm (`VOTER_SWARM_ENABLED`),
  safety gate (`SAFETY_GATE_ENFORCED`).
- **State on disk:** `database/decision-ledger.jsonl` (ledger),
  `database/reputation-memory.json` (reputation).

## Consequences

The wiring is additive and fail-closed/soft by design: no existing gate is
loosened, and every new optional path degrades to its prior behavior when its
env gate or provider is absent.
