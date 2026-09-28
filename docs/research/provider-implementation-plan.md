# Provider Role Architecture — Implementation Plan & Status (2026-09-29)

Implements `docs/research/provider-operations-budget.md` + `provider-role-and-endpoints-report.md`
in code. Every new module is env-gated, fail-soft, and fully unit-tested; default DRY_RUN
boot is unchanged.

## P0 — shipped in this pass

| Item | File(s) | Status |
| --- | --- | --- |
| **P0.5 ProviderGovernor** (shared budget/rate/cache/backoff) | `src/services/provider-governor.ts` | ✅ |
| **P0.3 CandidateHint → verify → candidate** | `src/discovery/candidate-hints.ts` + `DiscoverySource += 'fomo'` | ✅ |
| **P0.1 FOMO API emitter** (leaderboard/token-board/identity/devs/holders) | `src/adapters/fomo-api.ts`, `fomo-emitter.ts` | ✅ |
| **P0.4 TraderPersistence (24h∩7d∩30d) + WalletGraph** | `src/services/onchain/trader-persistence.ts`, `wallet-graph.ts` | ✅ |
| **Agent wiring** (FOMO token candidates + trader-intel ingestion) | `robinhood-screening-agent.ts`, `robinhood-discovery.ts`, `gmgn-adapter.ts` | ✅ |
| **Boot wiring** | `src/index.ts` (`fomo:` feed) | ✅ |

## P1 — shipped in this pass

| Item | File(s) | Status |
| --- | --- | --- |
| **P1.5 DeFiLlama regime feed** (regime context, not a voter) | `src/adapters/defillama-feed.ts` | ✅ |
| **P1.4 Arkham entity enricher** (entity/deployer/label/counterparty, ~100 cr/day cap) | `src/adapters/arkham-enrich.ts` | ✅ |

## P2 — optional / gated (kept off unless registry stats show value)

GeckoTerminal / CMC Dex / CoinStats / Birdeye feeds already exist and self-pace (30/min,
15K cr, 20K cr, 30K CU). They stay behind their existing env gates + `DISCOVERY_INTRODUCERS`.
The shared `ProviderGovernor` is available to hard-cap any of them as registry data demands.
Helius webhook (1 cr/event) remains the preferred production introducer over the pull feed.

## Budget governor registration (P0.5 semantics)

- **FOMO API:** dailyCap 250,000 cr, rpm 20, assumed cost 250/call; reads `x-credits-cost`.
- **Arkham:** dailyCap 100 cr (trial-friendly), rpm 30, assumed cost 1/call, 24h cache.
- Cache keying (`chain:address:endpoint`) + `402/429` → freeze/backoff + registry demote.

## Verification

- `npx tsc --noEmit` — clean.
- `npx vitest run` — 151 files / 1098 tests green (added 22 new tests for the P0/P1 modules).

## Not doing (explicit demotions, per research)

- BullX / Photon / Axiom as own feeds (no public free API → on-chain/skip).
- DeFiLlama as a token-score voter (regime only).
- Any emitter as a canonical introducer (provenance rule: FOMO/GMGN hint, on-chain verifies).
