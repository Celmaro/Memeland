# Research: SolanaTracker + PumpDev — endpoints, rate limits, and stack placement

Status: researched 2026-09-29 against current vendor docs; not yet implemented.
Owner keys provided by operator:
- SolanaTracker Data API key `59c77087-c10b-4a36-9a8a-802703e75eb8` (free tier)
- PumpDev WebSocket key `wss://pumpdev.io/ws?key=qySE5wX3q4kEmYhOQ4M6hGYraIBub0JWhucLjmad3CNDgYpQautDZbOts2Kr8iGs`

Both are **Solana-only** data sources. Neither introduces raw addresses at the
canonical, real-time, on-chain level the way Helius SPL-create (Sol) and Ankr
PairCreated (EVM) do, so they slot in **below** the introducer tier as an
enricher and a tape/entropy transport — never as a standalone score voter.

---

## 1. SolanaTracker Data API

### Identity / auth
- REST base: `https://data.solanatracker.io` (JSON)
- Auth header: `x-api-key: <key>` (the quickstart's curl uses `-H "x-api-key: ..."`)
- ~70+ REST endpoints, one free Data API key covers all of them
- Datastream WebSocket (`wss://datastream.solanatracker.io/{apiKey}`) is a
  **separate paid product** — REST key ≠ Datastream access

### Rate limits (free tier)
| Limit | Value |
| --- | --- |
| Requests / month | **10,000** |
| Rate limit | **3 req/sec** (burst/pacer — this is the binding constraint) |
| Datastream WS | **No** (Premium starts at €397/mo) |
| Over-quota behaviour | HTTP `429 Too Many Requests`; no roll-over of unused |
| Check remaining | `GET /credits`, `GET /subscription` |

Annual billing saves 30% on paid plans (Advanced €50 / 200k, Pro €200 / 1M,
Premium €397 / 10M + Datastream). For planning we assume **10k req/mo @ 3 rps**.

### Endpoint map (group → concrete endpoints → likely role)
| Group | Endpoints | Role in this stack |
| --- | --- | --- |
| Discovery | `/tokens/latest`, `/tokens/overview` (latest/graduating/graduated), `/tokens/graduating`, `/tokens/graduated`, `/tokens/trending`, `/tokens/top-performing`, `/tokens/{token}/pools`, token-by-pool, get-multiple | candidate emitter / recall source |
| Price | `/price?token=`, `POST /prices` (batch ≤100), `/price/historic`, `/price/historic/{ts}`, low/high in range | **enricher** (hydration) |
| Token research | `/tokens/{token}` overview, pool, `/tokens/{token}/stats`, top-20 / all holders, holder/insiders/snipers/bundlers charts | **enricher** |
| Security/risk | `/tokens/{token}/risk` — rug-pull signals, freeze & mint authority, holder concentration, bundler detection | **enricher** (risk read, complements GoPlus/CoinStats) |
| Wallet / PnL | `/wallet/{wallet}/tokens`, `/wallet/{wallet}/trades`, PnL V2 | enricher / recall (whale) |
| Smart-money | sniper / bundler / insider detection (early buyers, positions, PnL) | candidate **emitter** signal, recall-only |
| Health | `/credits`, `/subscription` | governor budget signal |

### Placement verdict — **ENRICHER (Sol)**, dual-use emitter recall
- All SolanaTracker data is **indexer-derived** (best-effort latency, polled)
  and can be hydrated from any **already-known token address**. That is the
  definition of the enricher role, not an introducer.
- Primary jobs on Sol: market price `/price` (batch up to 100), token overview +
  `stats`, **holder concentration** (feeds QLO/wallet-hygiene signals), and the
  **risk score** endpoint (a Sol-side stand-in next to GoPlus/CoinStats).
- Optional secondary: `/tokens/top-performing` + sniper/bundler/insider chart
  endpoints can emit smart-money signals — **recall-only**, never promoting
  without the on-chain verify gate (matches the emitter constraint).
- Free tier is tiny (10k/mo, 3 rps) → must live behind the shared
  `ProviderGovernor` with a hard daily cap + aggressive cache, and be
  **gated behind `DISCOVERY_INTRODUCERS`** if enabled (recall/hydrate only by
  default, matching the scoping model).

---

## 2. PumpDev WebSocket

### Identity / auth
- Endpoint: `wss://pumpdev.io/ws`
- Auth: query param `?key=<KEY>` **or** prefer the `{method:"auth", key:"..."}`
  control frame (keeps the key out of proxy/access logs).
- Control frames on connect: `{type:"connected"}`, `{type:"connectionStatus"}`
  (upstream feed health), `{type:"auth", status:"ok"|"free"|"error"}`. Gate
  subscription writes on the `auth` ack — it is answered asynchronously and
  re-sent unprompted when your tier changes.

### Rate limits (free-with-key tier; anonymous is 5× smaller in parens)
| Param | Free (key) | Anonymous |
| --- | --- | --- |
| Live subscription pool (tokens + wallets, shared) | **25** | 5 (per IP /64) |
| Max mints per `subscribeTokenTrade` call | **50** | 20 |
| Max wallets per `subscribeAccountTrade` call | **25** | 20 |
| Concurrent connections / IP | 1 | 1 |
| Total connections | 3 | 1 |
| Monthly trade-message quota | **50k** | 10k |
| Max control messages / 10 s | **40** | 40 |
| Max subscription key ops / 10 s | **600** | 600 |
| Max message size | 256 KB (refused with `MESSAGE_TOO_LARGE`) | same |

**Launches are always free on every tier** — `subscribeNewToken` events never
touch the trade quota. Only *delivered buy/sell messages* are metered; when the
quota runs out, trade messages are soft-throttled but the socket stays open and
launches keep flowing.

### Subscriptions / events
| Method | Payload | Delivered `txType` |
| --- | --- | --- |
| `subscribeNewToken` | — | `create` (every new Pump.fun launch) |
| `subscribeTokenTrade` | `keys:[mint]` | `buy`,`sell`,`complete`,`create_pool` |
| `subscribeAccountTrade` | `keys:[wallet]` | `buy`,`sell` by those wallets |

Each has a matching `unsubscribe…`. A token subscription follows the mint for
its whole lifecycle — bonding curve → migration (`complete` then `create_pool`)
→ canonical PumpSwap pool — with no re-subscribe. Only the **canonical** pool
is surfaced (`isCanonicalPool: true`).

Data highlights per event: `signature`, `mint`, `traderPublicKey`, `txType`,
`quoteMint`, quote-aware `quoteAmount`/`marketCapQuote` (may be `null` →
`quoteContextResolved:false` → read raw `*Raw`/reserve fields; never assume 9
decimals for a non-SOL pair), bonding-curve reserve fields
(`vTokensInBondingCurve`, `vQuoteInBondingCurve`, `vSolInBondingCurve`), and on
PumpSwap `poolEffectiveQuoteReserves / poolBaseReserves`.

Production requirements: reconnect with exponential backoff, **re-auth + re-sub
on every connect** (auth is per connection), wrap `JSON.parse` in try/catch,
watch for silence as a disconnect signal, batch keys (but stay within the live
subscription pool — oversized batches are clamped, not rejected).

### Placement verdict — **TRANSPORT (WS tape / entropy)**, Sol pre-graduation INTRODUCER + wallet-intel recall
- `subscribeNewToken` is a **real-time tape/entropy feed** — every brand-new
  Pump.fun launch millisecond-after confirmation. This is the transport/tape
  role (high-frequency, push, low-value-per-event volume).
- Because a `create` event carries the **raw mint address**, it also acts as a
  **Sol pre-graduation introducer** for the fresh lane. These launches are
  still on the bonding curve, so they feed the **FRESH LANE / pre-graduation
  tracker** and are correctly rejected by the existing graduated-only
  `isGraduatedToken(exchange='pump')` gate before the emit funnel — i.e. a
  *complimentary* Sol introducer to Helius SPL-create, focused on pump.fun
  launch events rather than generic SPL-create logs.
- `subscribeTokenTrade` → live price/trade ticks for tracked mints (tape).
- `subscribeAccountTrade` → whale/copy-trade wallet movements → **recall intel**,
  the direct analog of the FOMO tax-trader intel / wallet graph, feeding the
  on-chain persistent-trader cohort.
- Recommended governor interaction: WS is push (no request bursts) → it needs a
  connection/health budget + reconnect sled, not an rpm bucket. New-launch
  events are free; only the trade stream needs a monthly ceiling (50k).

---

## 3. Placement in the four-role stack (summary)

| Role | SolanaTracker | PumpDev |
| --- | --- | --- |
| **transport** | REST (HTTP) | **WS tape / entropy** |
| **canonical introducer** | — (indexer, not raw real-time) | Sol pre-graduation (pump launches) * |
| **candidate emitter** | recall-only (top-performing / sniper / insider) | recall-only (whale/copy trades) |
| **enricher** | **price, overview, stats, holders, risk** | — (thin per-event, price/tape) |
| **regime / entity / verify / decision** | risk=enricher only | — |

\* PumpDev new-launch events are pre-graduation; they do not replace Helius as
the graduated Sol introducer and are gated by the fresh-lane filter.

Both respect the rule: **emitters and enrichers recall/hydrate only; never
promote without the on-chain verify gate.**

---

## 4. Recommended env wiring + governor budget

```
# SolanaTracker (enricher, Sol) — free tier 10k/mo @ 3 rps
SOLANATRACKER_FEED_ENABLED=true
SOLANATRACKER_API_KEY=59c77087-c10b-4a36-9a8a-802703e75eb8
SOLANATRACKER_BASE_URL=https://data.solanatracker.io
# governor: hard daily cap (~300/day), rpm≈3, cache TTL 60s, freeze on 402+429

# PumpDev (WS tape / Sol pre-grad introducer)
PUMPDEV_FEED_ENABLED=true
PUMPDEV_WS_URL=wss://pumpdev.io/ws?key=qySE5wX3q4kEmYhOQ4M6hGYraIBub0JWhucLjmad3CNDgYpQautDZbOts2Kr8iGs
# governor: reconnect/sled budget; monthly trade ceiling 50k; launches free
```

`DISCOVERY_INTRODUCERS` (already `helius-sol,ankr-eth,ankr-base,ankr-bsc` in
local `.env`): leave both out of the promote set → SolanaTracker and PumpDev
enrich/recall only. Unset the var for full back-compat promotion.

---

## 5. Caveats
- **Local connectivity**: both `data.solanatracker.io` and `app.fomoapi.io` are
  TLS/connection-blocked by the dev machine's transparent MITM proxy
  (http 000 / b-cdn cert), the same class of issue as `gateway.zeabur.com`.
  They are reachable from Zeabur cloud. Live key validation must run in the
  cloud (or via a routed proxy), not from this machine.
- **SolanaTracker key** must be live-validated in the cloud (`GET /credits` →
  expect `monthlyLimit=10000`, `rpsLimit=3`); confirm it is the free tier.
- **PumpDev WS** is long-lived — requires a persistent WS client with re-auth +
  re-subscribe on reconnect and a health watchdog; not a per-cycle poller.
- **Devnet trap**: the operator's Ankr Solana URL is `…/solana_devnet/…`
  (testnet). Do not wire it as `SOLANA_RPC_URL` (mainnet reads would fail). A
  mainnet Ankr Sol endpoint would be `https://rpc.ankr.com/solana/<key>`.