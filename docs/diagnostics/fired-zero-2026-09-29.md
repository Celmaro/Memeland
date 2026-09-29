# Diagnostic Report — Memeland `fired=0`

**Status:** read-only diagnostic. No code changed, per `AGENTS.md`:
*"fired=0 across deploys ⇒ diagnostic report, not another patch."*

**Date:** 2026-09-29
**Deployment audited:** `6abb481c498d5ec175a08684` (RUNNING, service `memeland`,
project `6aafa032477bfd0030146662`)
**Code compared against:** local `master` @ `88db13d`

---

## 1. The signature that enabled this report

Live log signature, quoted verbatim from the running deployment:

```
[FUNNEL] cycle: agents=meme-robinhood meme.scan=105 meme.prefilter=5
        meme.emit=0 beforeGate=0 afterGate=0
        (cumulative: {"scanned":5957,"consensus":0})
```

`scanned: 5957`, `consensus: 0`. Zero consensus passes in the entire life of
the bot, not merely in this window. The repo's own detector
(`screening-cycle.ts:199-203`) fires `[STALE GATE]` only every 12th zero cycle,
so it is not visible in a 2-cycle log pull — the cumulative counter is the
honest signal, not the absence of the warning.

## 2. Where the funnel actually dies

Observed across two consecutive cycles:

| Stage | Cycle A | Cycle B | Rate |
|---|---|---|---|
| `meme.scan` (discovered) | 105 | 70 | — |
| `meme.prefilter` (normalized) | 5 | 3 | **4.3–4.8%** |
| `meme.emit` | 0 | 1 | — |
| `beforeGate` | 0 | 1 | — |
| `afterGate` | 0 | 0 | **0%** |

The bottleneck is **stage 2, the prefilter: ~95% of discovered candidates are
rejected before the consensus gate is ever consulted.**

This is *by design*, not a bug. `preFilterToken`
(`gmgn-meme-helpers.ts:128-188`) is fail-closed on four independent numeric
floors plus a security audit:

| Gate | Threshold | Source |
|---|---|---|
| volume 1h (mature) | **$50,000** | `robinhood-screening-agent.ts:81` |
| volume 1h (fresh lane) | $3,000 | `:89` |
| liquidity | $10,000 | `:82` |
| market cap | $100,000 | `:83` |
| security audit | honeypot / tax / rug / insider / top-10 / wash | `:177` |

A $50k *one-hour* volume floor plus a $100k market-cap floor is a strict gate
for memecoins. ~5% survival is the expected shape, not a leak.

**Conclusion: the prefilter is not the anomaly. The anomaly is `afterGate=0`
against a `beforeGate` of 0–1 — i.e. the gate is barely being reached at all.**

## 3. The one candidate that reached the gate was correctly refused

```
[FUNNEL] meme.scan=70 prefilter=3 emit=1 beforeGate=1 afterGate=0
[CONSENSUS GATE] MEME_ROBINHOOD LINK rejected (confidence 65%) [SECURITY] — not posting.
```

Emitted by `index.ts:118`. `LINK` scored **65% with a populated voter slate**,
and was vetoed by the security hard-gate (65 < 70) before any averaging.

**This is the gate working exactly as designed.** Two explicit corrections to
earlier analysis in this session:

1. **The abstention-inflation hole did not cause this rejection.** LINK had a
   rendered slate and a real confidence of 65. It was a genuinely weak
   candidate, not a denominator artifact. The `MIN_RENDERED_VOTER_SLOTS` gate
   added in `1dba05f` targets a different case and was not exercised here.
2. **The `-1` fail-closed sentinel was not hit.** The refusal code is
   `SECURITY` with a concrete score of 65, not a fabricated or missing value.

## 4. Secondary finding: CoinGecko 403 degrades the Sol chain every cycle

```
[MEME AGENT] SOL price: UNAVAILABLE (fee gate will reject all)
[PRICE SERVICE ERROR] CoinGecko failed (CoinGecko HTTP error: 403) — trying exchange fallbacks.
[PRICE SERVICE] Exchange fallback prices loaded (gate unstuck).
```

Present in **100% of observed cycles**. The design is correct — fail-closed,
then recover via exchange fallback ("gate unstuck"). The inefficiency is that a
hard 403 from a refusing host is retried on every cycle: at a 5-min cadence
that is ~288 futile calls/day. `sol` is also the largest scan share
(`sol:34` / `sol:35` of ~105), so it is the chain paying this cost.

## 5. Open question — fresh-lane maturity with $0 volume

```
[FRESH LANE] 0XA246 (bsc) matured: vol1h $0.0k liq $12.8k — now eligible at the mature floor.
[FRESH LANE] 88ZRKP (sol) matured: vol1h $0.0k liq $18.4k — now eligible at the mature floor.
[FRESH LANE] enrichment: 16/34 fresh pairs resolved real market data (34 attempted).
[FRESH LANE] enrichment: 3/8 fresh pairs resolved real market data (8 attempted).
```

Three of five observed "matured" pairs carry `vol1h $0.0k`, and enrichment
resolves 16/34 (47%) and 3/8 (38%). Given the `UNAVAILABLE != 0` rule, a `$0.0k`
reading is indistinguishable from an unresolved enrichment in logs alone.

This is **not proven to be a defect** — a genuinely dead pair is a legitimate
maturity. It is flagged because it is the most plausible source of the
"matured but still 0 prefilter survivors" pattern, and because it would be
invisible to the current counters.

## 6. Blocker for any further diagnosis

**The running deployment has no commit SHA.** `6abb481c498d5ec175a08684` is
`RUNNING` with an empty `COMMITSHA`; the newest git-linked deployment
(`143ea05`, "Phase 4") is `REMOVED`. Production is therefore running an
**unidentified build**, so it cannot be assumed to match any local commit.

Additionally, both local commits (`1dba05f`, `88db13d`) are **unpushed**, so
they are definitionally absent from production.

Log retention is short: the `LINK` rejection and the `[FUNNEL]` lines aged out
of the buffer between two consecutive pulls minutes apart. Multi-cycle
conclusions rest on a ~2-cycle window plus the cumulative counters.

---

## Recommendations (no action taken)

1. **Identify the running build.** Redeploy from a known SHA. Until then,
   production behavior cannot be attributed to any commit, which makes every
   other finding provisional.
2. **Push `1dba05f` + `88db13d`** so production matches `master` and the
   evidence-coverage gate is live.
3. **Circuit-break the CoinGecko 403** — one 403 should suppress the host for
   the session instead of retrying per cycle. Cheap, contained, no gate impact.
4. **Instrument the prefilter's rejection reasons.** The funnel counts
   *survivors* only. Emitting the `fail(...)` reason distribution per cycle
   (already computed at `gmgn-meme-helpers.ts:134`) would show *which* of the
   four floors is binding, and would settle the fresh-lane `$0.0k` question
   without a patch to screening logic.
5. **Raise `STALE_GATE_ALERT_AFTER_CYCLES` sensitivity or log every cycle.**
   The 12-cycle modulo means a silently non-firing bot is invisible in short
   log pulls — the exact situation this report had to work around.

**Explicitly not recommended:** loosening the prefilter floors or the 80%
consensus floor. The observed behavior is a fail-closed pipeline behaving
correctly under a $50k/1h volume bar. AGENTS.md non-negotiables #1 and #7
forbid trading those off to make a counter move.
