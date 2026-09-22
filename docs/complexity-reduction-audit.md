# Memeland complexity-reduction audit

**Anchor:** master @ `6909e65`. **124 test files / 912 tests green.** `npx tsc --noEmit` clean.

**Codebase size:** 130 source files, 25,370 LOC src/. 124 test files. Test-to-source ratio ≈ 0.95:1 (healthy).

## Part 1 — 12-PR plan vs current state

All 12 PRs from `docs/implementation-plan-merge.md` are landed, including PR 2 (Kernel E — `Result<T,E>` + EVM RPC two-lane): the `callLegacy` throw-shim is removed, `evm-adapter.request()` returns `{ ok: false, error }` instead of throwing, and `quoter-call-adapter.ts` bridges the legacy caller contract.

| PR | Kernel / Standalone | Status | Evidence |
|---|---|---|---|
| 1 | C: Decision Ledger | **DONE** | `services/decision-ledger.ts` + tests |
| 2 | E: `Result<T,E>` + EVM RPC two-lane | **DONE** | `evm-adapter.ts:261` G2 deprecation complete; `callLegacy` removed; `quoter-call-adapter.ts` bridge |
| 3 | B: Swarm Consensus golden-master | **DONE** (additive) | `swarm-guards.ts`; `aggregateVoterScores` intact |
| 4 | A: Reputation Memory | **DONE** | `reputation-memory.ts` (uses `atomic-file-store.ts`) |
| 5 | F: Decision Cache | **DONE** | `decision-cache.ts` — `getSticky`/`getImmutable` present |
| 6 | D: Sellability + Bytecode | **DONE** | `services/sellability/` + `bytecode-scanner.ts` |
| 7 | Standalone codex + dexpaprika feeds | **DONE** | both tested |
| 8 | Next-close simulator + backtest metrics | **DONE** | `next-close-simulator.ts`, `learning-harness.ts` |
| 9 | Risk profile + sizing (shadow-mode) | **DONE** | `risk-profile` gates log, don't enforce |
| 10 | Wallet-tracker extensions | **DONE** | `wallet-tracker.ts` (760 LOC — see Part 2) |
| 11 | QLO time-on-curve + hesitation memory | **DONE** | `CopyTradeHesitation` (in wallet-tracker.ts) |
| 12 | 10 Adapt-only micro-PRs | **DONE** | figure-grounding, autohedge-division, garch, fdv-hwm-exit, etc. |

## Part 2 — Where the real complexity lives now

The kernel program succeeded — the remaining complexity is **not** in orchestration kernels. It concentrates in the **adapter/data layer** and the **boot monolith**: 6 of the 15 heaviest files are adapters/agents, and the single biggest file in the repo is a data adapter, not a orchestrator.

**Top-15 heaviest files:**

| File | LOC | Role |
|---|---|---|
| `src/adapters/gmgn-adapter.ts` | **882** | biggest file in repo: discovery/security/track/rank/signals + key-pool + pacing + cache |
| `src/index.ts` | 761 | boot monolith; screening-cycle closure inline (lines 247–646, ~400 lines) |
| `src/services/wallet-tracker.ts` | **760** | **3 classes in one file**: WalletTracker, CopyTradeHesitation, BalanceBatchReader |
| `src/agents/meme-robinhood/robinhood-screening-agent.ts` | 718 | screening agent: discovery+enrich+audit+signal |
| `src/orchestrator/tool-registry.ts` | 697 | LLM tool surface |
| `src/adapters/lifi-executor.ts` | 629 | execution: quote/build/broadcast/status/nonce-store |
| `src/discord/handlers/command-handlers.ts` | 552 | slash-command surface |
| `src/services/ai-service.ts` | 528 | LLM calls |
| `src/agents/shared/gmgn-meme-helpers.ts` | 514 | GMGN helpers |
| `src/services/state-store.ts` | 502 | persistence |
| `src/adapters/evm-adapter.ts` | 478 | RPC two-lane |
| `src/orchestrator/voters.ts` | 475 | 10-voter swarm |
| `src/orchestrator/learning-harness.ts` | 468 | backtests |
| `src/orchestrator/strategy-engine.ts` | 463 | strategy worker |
| `src/orchestrator/risk-engine-v2.ts` | 447 | risk |

The 15 heaviest files ≈ **~9,500 LOC ≈ 37% of the codebase**. Two structural problems stand out:

1. **`index.ts` (761 LOC) still owns the live screening loop** — `runScreeningCycle` is a ~400-line inline closure (lines 247–646) capturing ~15 module-scope variables. It is the single hardest-to-test block in the repo.
2. **Three files are "one file, several jobs"** — `gmgn-adapter.ts` (15 public methods + an inline 230-line key-pool/retry client), `wallet-tracker.ts` (3 unrelated classes), `robinhood-screening-agent.ts` (full discovery→emit chain).

## Part 3 — 4 new Kernel opportunities

### Kernel S — Boot composition (collapses `src/index.ts`)

`src/index.ts` (761 LOC) owns: env loading + startup validation, Telegram/Discord wiring, strategy bootstrap, the screening cycle (heartbeats, equity, regime, dispatch, gate, dedup, post), price-alert interval, approval-queue wiring, update-report forwarder, TUI/command loop. The **screening-cycle closure (lines 247–646)** is the largest single concern.

Crucially, the dependency surface is **already contracted**: `src/runtime/screening-runner.ts` exports the `ScreeningDeps` interface (activeDomains / heartbeat / runPass / gate / dispatch / funnel) plus the tested `withScreeningTimeout` primitive. The extraction is mechanical — move the closure body into `runScreeningCycle(deps)`, leave `index.ts` as the assembly point.

```text
src/startup/boot.ts                  — assemble() returns BootContext (services + adapters)
src/startup/screening-cycle.ts      — runScreeningCycle(deps) (pure factory; deps injected)
src/startup/discord-bootstrap.ts    — wireDiscord(deps): registers channels/commands/menus
src/startup/telegram-bootstrap.ts   — wireTelegram(deps): topics + polling
src/startup/price-alert-loop.ts     — startPriceAlertLoop({ client, ...services })
src/startup/index.ts                — re-export
src/index.ts                        — shrinks to ~150 LOC: env, assertStartupConfig, assemble(), runCycle()
```

(Some pieces already exist — `bootstrap.ts`, `risk.ts`, `screening-scheduler.ts`, `shutdown.ts` — the missing ones are `screening-cycle.ts` and the channel-bootstrap splits.)

**Expected reduction:** `index.ts` 761 → ~150 LOC. The 400-line closure becomes a testable factory. **Net −400 LOC, +1 testable surface.**

### Kernel T — WalletTracker split (collapses 760 LOC)

`wallet-tracker.ts` holds **3 classes** for 3 unrelated concerns:

1. `WalletTracker` (line 53) — mirrors on-chain holdings into PositionManager lifecycle + exit alerts
2. `CopyTradeHesitation` (line 390) — QLO time-on-curve / hesitation memory
3. `BalanceBatchReader` (line 672) — batched balance reads

They share a file for no coupling reason. Each is independently testable:

```text
src/services/wallet-tracker.ts        — WalletTracker only (position mirroring)
src/services/copy-trade-hesitation.ts — CopyTradeHesitation (QLO time-on-curve)
src/services/balance-batch-reader.ts  — BalanceBatchReader
```

**Net −0 LOC, but 3 testable units instead of one class-that-is-also-a-file.**

### Kernel U — GMGN adapter split (collapses 882 LOC, biggest file)

`gmgn-adapter.ts` mixes 5 concerns:

- discovery — `fetchRank` / `fetchTrenches` (the `MarketDataProvider.discover` path)
- security — `fetchTokenSecurity` + audit normalization
- track — `fetchTrackTrades`
- single-token — `fetchTokenInfo` / `fetchTokenKlines`
- signals — `fetchTokenSignals` / `fetchHotSearches` / `fetchTrendingSignals`

…plus the **inline REST client** (`gmgnRequest`, lines 225–452): ~230 lines of key-pool rotation, pacing, retry, 429 handling that sits *before* the first public method even ends, and the TtlCache wiring from the KC1 migration.

```text
src/adapters/gmgn-adapter.ts        — implements MarketDataProvider.discover (rank/trenches/discovery)
src/adapters/gmgn-rest-client.ts    — gmgnRequest: key-pool, pacing, retry, 429 rotation
src/adapters/gmgn-security.ts       — fetchTokenSecurity + audit normalization
src/adapters/gmgn-track.ts          — fetchTrackTrades
src/adapters/gmgn-signals.ts        — klines/signals/hot/trending
```

**Net −0 LOC, but the biggest file becomes 5 focused files and the REST client becomes a reusable seam** (feed adapters, audit jobs, future key-pool consumers).

### Kernel V — RobinhoodScreeningAgent split (collapses 718 LOC)

`robinhood-screening-agent.ts` runs the full chain in one class: discovery → enrich → audit → funnel accounting → signal emit. The funnel counters already exist in `services/operational-funnel.ts`, so the agent can be decomposed into discovery / enrichment / audit passes without touching behavior.

```text
src/agents/meme-robinhood/robinhood-screening-agent.ts   — orchestration only
src/agents/meme-robinhood/robinhood-discovery.ts         — discovery pass
src/agents/meme-robinhood/robinhood-enrichment.ts        — enrich + audit pass
```

**Keep the `ScreeningAgent` contract stable (`runScreeningPass` → `AgentReport`). Net −0 LOC, hot-path decomposition.**

## Part 4 — Quick wins (under 100 LOC each, all open)

| Win | Where | Effect |
|---|---|---|
| **Move `strategistSightingFrom` to `opportunity-ledger.ts`** | `index.ts:118` | Domain mapping belongs next to the ledger. **Net −13 LOC inline.** |
| **Replace bespoke `recentSignals` Map with `DecisionCache.getSticky`** | `index.ts:237` | Kernel F's `getSticky` (decision-cache.ts:58) exists and is **unused in index.ts**. Reuse the 5-minute sticky TTL instead of a hand-rolled dedup Map + state-store hydrating. **Net −10 LOC, less state.** |
| **Route `state-store.ts` atomic writes through `atomic-file-store.ts`** | `state-store.ts` (502 LOC) | The primitive already exists and is used by 6 modules (ledger, reputation-memory, cron-scheduler, execution-gates, strategy-engine, swarm-learning). State-store still hand-rolls 2× writeFileSync-tmp/rename. **Net −20 LOC, one persistence path.** |
| **Add public `setSink()` to `ChatNotifier`** | `chat-notifier.ts:35` + `index.ts:142` | `bindDiscordClient` currently mutates the private sink via `(controlRoomNotifier as unknown as { sink }).sink = ...` — a type-unsafe cast. A real setter kills the hack. **Net −2 LOC, removes a type lie.** |
| **Drop duplicate `CONTROL_ROOM_NOTIFY_MS` constant** | `index.ts:135` | ChatNotifier already defaults `cooldownMs` to 10 minutes; index.ts re-declares the constant and passes it. Use the kernel default. **Net −4 LOC.** |

## Part 5 — Recommended execution order

Following the plan's "lowest collision / highest isolation first" principle:

1. **Quick wins** (Part 4) — single PR, ship today. No risk. Each is a verified-open, behavior-preserving cleanup.
2. **Kernel S — boot composition** — deps already contracted by the `ScreeningDeps` interface; the largest single-file reduction and the only one touching the live loop.
3. **Kernel T — wallet-tracker split** — pure file split, no behavior change, no test churn beyond import path updates.
4. **Kernel U — GMGN split** — biggest-file-in-repo reduction; REST-client extraction first (byte-for-byte), then method grouping.
5. **Kernel V — robinhood-agent split** — last; the discovery hot path is the most behavior-dense surface.

**Estimated reduction if all four Kernels ship:**

| Metric | Current | After | Δ |
|---|---|---|---|
| `index.ts` | 761 | ~150 | **−80%** |
| `gmgn-adapter.ts` | 882 | ~250 | **−72%** |
| `wallet-tracker.ts` | 760 | ~330 | **−57%** |
| Biggest file in repo | 882 | ~430 | **−51%** |
| Test count | 912 | ~970 | +58 (per-module coverage) |

**Behavior preservation:** all four are additive-only refactors — no public signature changes — so the 912-test floor stays green throughout.

## Part 6 — Risks to flag before any Kernel PR

- **Kernel S (boot)** — the only change touching the live production loop (screening cycle). *Move the closure verbatim — no restructuring.* The `ScreeningDeps` contract already froze the dependency list, but a shadow-mode smoke for one deploy cycle is still required before the old closure is deleted.
- **Kernel U (GMGN)** — `gmgnRequest` (lines 225–452) is the most behavior-dense code in the adapter: 429 rotation and key-pool semantics must not change. *Extract byte-for-byte first, then split the public methods.*
- **Kernel V (robinhood-agent)** — the discovery/enrichment hot path feeds the funnel counters and the consensus gate. *Keep `ScreeningAgent.runScreeningPass()` → `AgentReport` contract stable; verify the funnel counts before/after on a recorded pass.*
- **Kernel T (wallet-tracker)** — position mirroring touches real exit alerts. *Only move classes between files; no logic edits.*

## Part 7 — One thing the plan got wrong

The plan assumed complexity would keep concentrating in **orchestration kernels** (swarm, ledger, cache, sellability) — and it did not. The plan's own success created a blind spot: **the adapter/data layer grew unchecked**. The single biggest file in the repo is now a data adapter (`gmgn-adapter.ts`, 882 LOC), and PR 10's "extensions" pattern grew `wallet-tracker.ts` into a 760-LOC file holding three unrelated classes. None of the 12 PRs anticipated adapter-layer consolidation, so there is no `REST-client` kernel, no shared `GMGN-read` seam, and no rule about "one file, one class, one chain."

**The fix is the shape of this audit:** Kernels T and U are exactly the missing "data-layer consolidation" track, and the quick-win row "route state-store through `atomic-file-store.ts`" is the same insight at a smaller scale. The next consolidation round should budget for adapters, not more orchestration kernels.

**TL;DR:** The 12-PR plan is fully landed. Complexity today lives in the **data adapter layer** (GMGN 882 LOC, wallet-tracker 760 LOC across 3 classes, robinhood-agent 718 LOC) plus the **boot monolith** (`index.ts` 761 LOC with a ~400-line inline screening-cycle closure). Four new additive Kernels — S (boot composition, deps already contracted), T (wallet-tracker split), U (GMGN split around the `gmgnRequest` REST-client seam), V (robinhood-agent decomposition) — plus five quick wins (ledger mapping move, `DecisionCache.getSticky` reuse, state-store persistence path, ChatNotifier setter, dead constant) could cut the biggest file in half and the boot monolith by 80%, while preserving every existing behavior.