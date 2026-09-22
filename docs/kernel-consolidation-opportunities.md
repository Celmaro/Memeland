# Memeland — Kernel Consolidation Opportunities Review (Post-Plan-Merge)

Status: **plan only. No code changed yet.** A direct follow-up to
[`docs/implementation-plan-merge.md`](./implementation-plan-merge.md)
which consolidated 91 items into 12 Kernels / Standalones. That work shipped
**PR 1–PR 12** plus **PR 2 wrap-up** and the **LI.FI multi-chain fixes
(R1–R10)** — the 12-PR plan is closed.

This review asks a different question: **what duplication has appeared in
the 24,846 LOC codebase since those kernels landed?** Targets are
**purely additive refactors** with the same shape as the 12-PR plan
(anchor + tests green + additive-only).

Anchor: `master @ 9d5b4c56767ac30d2197fc00d0e6efc701bb8e99`. **117 test
files / 859 tests green**, `npx tsc --noEmit` clean. Total: 123 source files,
24,846 LOC.

## How to run the suite and contribute tests

- Run all: `npm test`
- One file: `npx vitest run tests/<file>.test.ts`
- Typecheck: `npx tsc --noEmit`
- ESM: `.js` import extensions required in `tests/*.test.ts` into `src/**`.
- TDD loop per KC (kernel-consolidation):
  1. Write the failing test(s) named for the consolidation behaviour.
  2. Confirm they fail for the right reason (a real duplication, not a stub).
  3. Implement the smallest module change that turns them green.
  4. Full suite + `tsc --noEmit` green, then commit the KC as one unit.

## Execution order (9 KCs, dependency-first)

Order prioritizes **smallest risk / fewest call sites first** (so each KC
lands as a tightly-scoped commit and we can stop cleanly if any breaks
the floor). KC1–KC4 are pure utility extractions; KC5–KC7 split
monoliths already audited in the original plan; KC8–KC9 are
documentation/audit cleanup.

### KC1 - Kernel L: TtlCache (new `src/cache/ttl-cache.ts`)

**Absorbs:** the **8** ad-hoc TTL-cached Maps across adapters:

| Site | Pattern |
|---|---|
| `adapters/codex-feed.ts:43` | `Map<string, { at: number; data: MarketToken[] }>` |
| `adapters/dexpaprika-feed.ts:62` | same |
| `adapters/dexscreener-feed.ts:43` | same |
| `adapters/gmgn-adapter.ts:175` | `discoveryCache` |
| `adapters/gmgn-adapter.ts:178` | `securityCache` + `SECURITY_CACHE_TTL_MS = 10 * 60 * 1000` |
| `adapters/gmgn-adapter.ts:182` | `trackCache` + `TRACK_CACHE_TTL_MS = 60 * 1000` |
| `adapters/hyperliquid-adapter.ts:49` | `LEADERBOARD_TTL_MS` |
| `adapters/rh-fill-tape.ts:62` | `labelCache: Map<string, { label: string; at: number }>` |
| `services/price-feed-service.ts:4` | `lastFetchTime` + `cacheDurationMs` (single-key variant) |

**Change:** `TtlCache<V>(opts: { ttlMs: number; maxEntries?: number; now?: () => number })` exposing `get(key)`, `set(key, value)`, `has(key)`, `delete(key)`, `clear()`. Auto-eviction on read past TTL, optional LRU cap. Adapter sites keep their public methods, only the underlying Map literal changes. The price-feed single-key variant becomes a `TtlCache` with one slot.

**Tests:** new `tests/ttl-cache.test.ts` (TTL expiry, maxEntries eviction, concurrent set, now injection).

**Verify:** `npm test` + `npx tsc --noEmit`. Floor stays green; behavior preserved (test-first). Commit KC1.

### KC2 - Kernel M: PacedHttpClient (new `src/io/paced-http-client.ts`)

**Absorbs:** the **3** ad-hoc fetch pacers (global `requestQueue` + `lastRequestAt`):

| Site | Pattern |
|---|---|
| `adapters/gmgn-adapter.ts:192–207` | `static requestQueue` + `static lastRequestAt` + `pacedFetch()` |
| `adapters/lifi-executor.ts:149–269` | `let requestQueue` + `let lastRequestAt` + `paced<T>()` |
| (3rd — check during impl) | any future adapter needs the same pattern |

**Change:** `PacedHttpClient({ baseSpacingMs: number, fetchImpl?: typeof fetch, now?: () => number })` with `pacedFetch(url, init?)` returning `Promise<Response | null>` (null on network error / non-ok with logged warning, same semantics both adapters use today). Adapters compose `pacedFetch` with their own headers/body + retry / key-pool layers above it.

**Tests:** new `tests/paced-http-client.test.ts` (queue ordering, spacing honored, fetch injection).

**Verify:** `npm test` + `npx tsc --noEmit`. Commit KC2.

### KC3 - Kernel N: TryFetchJson (new `src/io/try-fetch-json.ts`)

**Absorbs:** the **`try { await fetch(...) } catch { return null }`** pattern across adapters and services. Verified at least 13 sites:

- `lifi-executor.lifiPost` / `lifiGet` (the 2 production callers)
- `gmgn-adapter` (every method)
- `goplus-security-service`
- `hyperliquid-adapter`
- `codex-feed` / `dexpaprika-feed` / `dexscreener-feed`
- `relay-adapter` (legacy)
- `opensea-adapter` (legacy)

Each duplicates: `try { res = await fetch(...); if (!res.ok) { warn(...); return null } return await res.json() } catch (e) { warn(...); return null }`.

**Change:** `tryFetchJson<T>(url, init?, opts?: { fetchImpl?, logger?: (msg) => void }): Promise<T | null>`. Adapters drop 8–15 LOC each.

**Tests:** new `tests/try-fetch-json.test.ts` (200/500/network-error → null; 200 + malformed body → null).

**Verify:** `npm test` + `npx tsc --noEmit`. Commit KC3.

### KC4 - Kernel O: StalenessClock (new `src/clock/staleness-clock.ts`)

**Absorbs:** the `Date.now() - this.lastFetchTime > this.cacheDurationMs` style in `price-feed-service.ts` and the bare `timestamp` bookkeeping in `swarm-consensus.ts:128` (`Date.now() - existingIntent.timestamp < 60 * 60 * 1000`).

**Change:** `class StalenessClock { constructor(ttlMs: number, now?: () => number); public touch(at?: number): void; public isStale(at?: number): boolean; public ageMs(at?: number): number; }` — pure utility, no I/O. Add `ageMs()` so callers can show "last seen 23s ago" without re-reading `Date.now()`.

**Tests:** new `tests/staleness-clock.test.ts` (touch/isStale transitions, clock injection, ageMs precision).

**Verify:** `npm test` + `npx tsc --noEmit`. Commit KC4.

### KC5 - Kernel P: ChatNotifier (new `src/notifications/chat-notifier.ts`)

**Absorbs:** `notifyControlRoom(client, key, content)` in `src/index.ts:132–148` — called from **5 sites** in `index.ts` (risk gate, kill-switch, position alert, loop error, plus the imported-but-unused `let runtimeStop`). Same signature + same cooldown map in all 5 callers. Currently swallowed in standalone mode.

**Change:** `class ChatNotifier { constructor(opts: { cooldownMs, client?, logger?: (msg) => void, now?: () => number }); public post(key: string, content: string): Promise<void>; public snapshot(): { cooldownRemainingByKey: Record<string, number> }; }`. One module-level instance replaces the 5 call sites and the standalone fallback is the default logger. Becomes the seam for future channels (Telegram, Slack).

**Tests:** new `tests/chat-notifier.test.ts` (cooldown, standalone logger, exception swallowed, snapshot shape).

**Verify:** `npm test` + `npx tsc --noEmit`. Commit KC5.

### KC6 - Kernel Q: ScreeningRunner (new `src/runtime/screening-runner.ts`)

**Absorbs:** the `withScreeningTimeout` helper (defined at `src/index.ts:134`, called 2× in `index.ts:301,310`) + the `dispatchDomain` wrapper in `src/orchestrator/dispatch.ts` + the inline per-domain dispatch blocks at `src/index.ts:296–312` + the larger `runScreeningCycle` closure in `index.ts:283–410`. The whole screening-cycle composition lives in 130+ lines of inline closure that grew out of the original plan's Kernel #9 split.

**Change:** `runScreeningCycle(deps: ScreeningDeps): Promise<CycleReport>` where `ScreeningDeps` carries the hub, agents, scheduler helpers, gate, and notifier. The inline closure in `index.ts` collapses to one call. Also surface a `withScreeningTimeout<T>(promise, domain, ms)` exported helper so the timeout is testable.

**Tests:** new `tests/screening-runner.test.ts` (timeout swallow, one-pass-per-cycle report shape, dispatch error isolation).

**Verify:** `npm test` + `npx tsc --noEmit`. Commit KC6.

### KC7 - Kernel R: WalletBalanceReader (new `src/services/wallet-balance-reader.ts`)

**Absorbs:** the `walletService.getEvmBalance(4663)` call pattern duplicated across **6 sites**: `index.ts:268`, `cli/tui.ts:112`, `discord/handlers/interaction-buttons.ts:73`, `discord/handlers/command-handlers.ts:37,107`, `orchestrator/tool-registry.ts:603`. All hard-code chain id `4663` (Robinhood Chain) at the call site — if the multi-chain migration adds more balance sources, every caller must update.

**Change:** `class WalletBalanceReader { constructor(wallet: WalletService, defaultChainId?: number = 4663); public async getEthEquivalentUsd(): Promise<{ chainId: number; balance: number; symbol: string; usdValue: number } | null>; public async getForChain(chainId: number): Promise<BalanceResult | null>; }`. Each call site becomes `await reader.getEthEquivalentUsd()` (single dependency surface, future-multi-chain ready).

**Tests:** new `tests/wallet-balance-reader.test.ts` (price-missing fail-open, network-error fail-open, multi-chain override).

**Verify:** `npm test` + `npx tsc --noEmit`. Commit KC7.

### KC8 - docs(audit): closure of original plan

**Absorbs:** the open-flag list from `docs/implementation-plan-merge.md:135–137` that is now resolved:
- "Totals: ~3,170 LOC, 30 new test files, 12 PRs" → closeout delta
- "Re-verify every report line/test name against current master before each PR (report anchored at `afbb2f2`/546 tests; current `989f69f`/547)" → fully closed
- "Single golden-master risk is PR 3" → Kernel B shipped additively; consensus numbers preserved

**Change:** update `docs/implementation-plan-merge.md` to add a "Status: closed" header, append the LI.FI audit + consolidation-review references. No code change.

**Verify:** `git diff -- docs/implementation-plan-merge.md` is text-only. Commit KC8.

### KC9 - docs(README): kernel catalogue

**Absorbs:** the implicit "where do I find X" knowledge currently scattered across AGENTS.md, HANDOFF.md, and this audit. New operators land on the README and have no map.

**Change:** add a `docs/KERNEL_CATALOG.md` listing every kernel (C, E, B, A, F, D, G/L/M/N/O/P/Q/R + the new LI.FI audit additions) with: file path, one-line purpose, public API surface, key tests. Cross-referenced from `README.md`.

**Verify:** `git diff -- docs/` is text-only. Commit KC9.

## The "no break" guarantees

- **G1 (inherited):** all KCs are additive — no existing signature changes. The 859-test floor stays green.
- **G6 (new, KC1–KC7):** cache/rate-limit/timeout semantics **must** be preserved bit-for-bit. Each adapter keeps its public method contracts; only the underlying primitive changes. Test-first: every existing test in the affected adapter file is the regression floor.
- **G7 (new, KC6):** the screening cycle composition's behavior — including equity drawdown tracking, whale regime overlay, and consensus gate — is the production floor. KC6 must re-run a live-cycle smoke (or replay a recorded input) before commit.

## Dependency diagram

```text
KC1 TtlCache ─────────┐
                      │
KC2 PacedHttpClient ──┤  independent (utility primitives)
KC3 TryFetchJson ─────┤
KC4 StalenessClock ───┘

KC5 ChatNotifier ─────── depends on KC4 (uses clock for cooldown)
KC6 ScreeningRunner ──── depends on KC5 (uses notifier)
KC7 WalletBalanceReader ─ independent

KC8 docs(closure) ─────── text-only
KC9 docs(catalogue) ───── text-only
```

Order: KC1–KC4 first (utility primitives, each a single small file + small test), then KC5 → KC6 (notifier feeds the screening cycle), then KC7, then KC8 + KC9.

## Do-NOT-Merge (from audit + new review)

- **`lifi-executor.ts` rate-limiter (KC2)** — must NOT touch the existing `requestQueue` / `paced()` path until KC2 lands; the current `paced()` is per-instance, KC2 is module-level (one queue per provider), and changing that boundary changes failure modes.
- **LifiExecutor.broadcastNonces ↔ DecisionLedger.recordSend wiring** — currently the lifi-executor records its own outcome to its JSONL store (R3 from the LI.FI audit). Wiring it to `DecisionLedger.recordSend` is a *different* change and out of scope here; it would require teaching the ledger about `unknown` / `timed_out` outcomes.
- **`operational-health.ts` provider-status API** — already exists as `OperationalHealthRegistry`. KC1's `TtlCache` would be a *new* primitive that providers could *optionally* feed; do not refactor `OperationalHealthRegistry` to use `TtlCache` in KC1 — that's a separate change.
- **Module-level `process.env` reads** — KC4's `StalenessClock` accepts `now()` injection but does not hot-reload env. KC2's `PacedHttpClient` reads `spacingMs` at construction, not per-call. Keep that contract.

## Open flags

- Re-verify every KC against `origin/master` before commit (current `9d5b4c5`; PRs may land while KCs are in progress).
- KC6 (ScreeningRunner) is the only KC that touches the live production loop. Recommend landing KC6 behind a shadow-mode flag for one deploy cycle, then enforce.
- Total: 9 KCs, ~600 LOC of new utility code, ~50 LOC of new test code per KC. Single shadow-mode risk: KC6.

## Cross-references

- [`docs/implementation-plan-merge.md`](./implementation-plan-merge.md) — the 12-PR plan that closed before this review.
- `docs/research/memeland-merge-full-report.md` — the upstream report that drove the 12-PR plan.
- `docs/opportunity-ledger-design.md` — used by the screening cycle; relevant to KC6's contract.
