# Memeland Log Audit — Operator Runbook

Quick-reference for the patterns observed in the Zeabur deployment on
`master @ b44f866` (RUNNING 8h). Pair this with the live `zeabur deployment log`
view: `[FUNNEL] cycle: … meme.scan=N meme.prefilter=N …`.

## Quick triage table

| What you see in the log | Root cause | Fix |
|---|---|---|
| `meme.scan=155 meme.prefilter=0 beforeGate=0 afterGate=0` | Volume_1h is `0` for every token because GMGN `/v1/market/rank` on Robinhood omits `volume_1h` and `volume` | **Fix #2** (code, shipped): `volume1hUsd` now falls back to `volume24hUsd/24` when both explicit fields are absent |
| `[ROBINHOOD AGENT] ⛔ SYM: AUDIT FAIL — GMGN audit unavailable` flooding every cycle | Single GMGN key, no rotation — every audit after the first 429 silently returns `null` | **Fix #1** (env-only): fill `GMGN_API_KEY_ROBINHOOD` + `GMGN_BACKUP_KEYS` |
| `beforeGate=0 afterGate=0` with no idea why | Funnel log was missing the agent's own upstream counters | **Fix #4** (code, shipped): `meme.scan / meme.prefilter / meme.emit` printed inline with `beforeGate/afterGate` |
| `[ROBINHOOD AGENT] ⛔ SYM: AUDIT FAIL — GMGN audit unavailable (fail-closed)` — is this a token issue or a global outage? | No signal distinguishing rate-limit from real audit failure | **Fix #5** (code, shipped): `audit-unavailable` path now warns with the rate-limit hint instead of a generic fail |
| Only one chain (`[FUNNEL] meme chains=robinhood`) is scanned | Booster feeds default OFF + agent `chains: ['robinhood']` is the live default | **Fix #3** (env-only): `CODEX_FEED_ENABLED=true`, `DEXPAPRIKA_FEED_ENABLED=true`, `DEXSCREENER_FEED_ENABLED=true` |

## The 7-bucket diagnostic checklist (legacy)

When `[FUNNEL] cycle` shows `beforeGate=X afterGate=Y` with `meme.scan=A meme.prefilter=B meme.emit=C`, walk through this in order:

1. **`A = 0`** → GMGN fetchRank/Tranches/Hot returned empty. Look for `[GMGN] HTTP 429` / `[GMGN] Rate limited (BANNED)` in the cycle. Single key with no backups = every 429 kills the whole pass for the next 5 min. **Apply Fix #1.**
2. **`A > 0, B = 0`** → every token failed prefilter (volume / liquidity / holder / graduated). Most common case. Apply Fix #2.
3. **`B > 0, C = 0`** → voters returned `score: 0` on every candidate (no `nativePriceUsd`, no `walletMetrics`). Tighten the agent upstream or relax the swarm threshold.
4. **`C > 0, beforeGate = 0`** → `dispatchDomain` swallowed the reports. Check `dispatch.ts` log for `domain:` it received and `isActive()` returning `false`.
5. **`beforeGate > 0, afterGate = 0`** → gate doing its job. Read `[CONSENSUS GATE] domain SYM rejected (confidence N%) [refusal]` — refusal code (`REGIME_FLOOR`, `STICKY_BLOCK`, `VOL_LOW`, …) names the cause.
6. **`afterGate > 0, scorecard = 0`** → approvals + auto-exec filter (DISCORD/BOT_TOKEN unset → `OPERATOR_APPROVAL_REQUIRED=true` → no fire).
7. **No `[FUNNEL] cycle` log at all** → `runScreeningCycle` didn't reach the log line. Either `globalHealthWatcher.recordHeartbeat` threw, or the scheduler skipped. Look for `[SUB-AGENTS LOOP] Checking active sub-agent domains...`.

## What "fired=0" means (with current numbers)

The `cumulative: {"scanned":16586,"consensus":6,"fired":3}` print is a **lifetime** counter from `stateStore.funnels['meme-robinhood']`. On this deployment:

- `scanned=16586` — across all deployments since the last `opencatz_state.json` reset
- `consensus=6, fired=3` — historical; `opencatz_state.json` on disk has `scorecard: []`, `dedupEntries: {}`, `signalLedger: []` → these 9 never fired under the *current* configuration
- The current cycle always shows `beforeGate=0 afterGate=0` because **fixes #1 + #2 are not yet active in Zeabur env** (the env list still shows one GMGN key + no booster feeds)

Once you apply Fix #1 (Zeabur env: set `GMGN_API_KEY_ROBINHOOD` + `GMGN_BACKUP_KEYS`) and push the current `master` (which has Fix #2 already in `b44f866...` wait, no — fix #2 is in the next commit), the next cycle should show `meme.prefilter > 0` for the first time since the deployment started.

## Applying fixes

- **Fix #1 (env-only):** Zeabur → service `6aafa042477bfd0030146665` → env tab → add `GMGN_API_KEY_ROBINHOOD=***` + `GMGN_BACKUP_KEYS=***` → restart.
- **Fix #3 (env-only):** Same place → set `CODEX_FEED_ENABLED=true`, `DEXPAPRIKA_FEED_ENABLED=true`, `DEXSCREENER_FEED_ENABLED=true`.
- **Fix #2, #4, #5:** Code changes — already merged into `master` after `b44f866`. Push the next commit to deploy automatically.
