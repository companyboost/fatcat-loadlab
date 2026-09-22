# fatcat-loadlab

The isolated staging and load-testing environment for FatCat Arena: a Hyperliquid
simulator, a k6 load harness, and the runbook that wires them to a staging stack which
shares **nothing** with production.

This repository contains **no product source code and no credentials.** It is the
harness; the system under test is deployed separately from its own repositories.

---

## Why the product code is not forked here

The obvious reading of "a completely separate staging codebase" is to copy the backend
into this repo and point it at test infrastructure. That is the one thing this design
deliberately does not do.

A forked copy starts identical and diverges within days. Once it has, every number it
produces describes the fork, not the product — and the entire purpose of the exercise is
to predict how **production** behaves at 10,000 concurrent duels. A staging environment
that runs different code is not a staging environment; it is a second product.

Isolation is therefore achieved at the **infrastructure** layer, not the source layer:

| Layer | Production | Staging |
|---|---|---|
| Backend source | `companyboost/fatcat-backend` @ `main` | **the same repo and branch** |
| App source | `dukestudios/fatcat-app` @ `main` | **the same repo and branch** |
| Railway project | `modest-balance` | **its own project** |
| Supabase | its own project | **its own project** |
| Redis (Upstash) | its own instance | **its own instance** |
| Vercel project | `fatcat-app` | **its own project** |
| Hyperliquid | real testnet | **the simulator in this repo** |
| Escrow | its own Arbitrum Sepolia deployment | **its own deployment** |

Railway deploys a service directly from a GitHub repository. A **new Railway project**
pointed at `companyboost/fatcat-backend` therefore gives a staging backend running
identical code **without a single change to that repository** — no new branch, no CI
change, no workflow edit. The existing apps are untouched by construction.

> This also sidesteps a live defect: `WORKER_SERVICE_ENABLED` is a repository-wide GitHub
> variable, so a push to the existing `staging` branch would run
> `railway up --service fatcat-worker` against an environment with no such service and
> fail the job. We never push that branch, so it never fires.

---

## What lives here

```
hl-sim/     Hyperliquid simulator — REST info endpoints + WebSocket topics.
            Removes the upstream rate-limit ceiling so the internal limits can be measured.
k6/         Load scenarios. Ported from the workspace `loadtest/` set, plus the
            SSE assertions that set never had.
docs/       RUNBOOK.md — the ordered environment build.
            ARCHITECTURE.md — what breaks at 10k and in which order.
scripts/    Helpers for provisioning and verification.
```

---

## The ceilings this exists to measure

Production is capped by Hyperliquid long before any internal limit is reached: one live
duel costs ~2,028 request-weight/minute against a documented **1,200/min per-IP** budget,
and user-specific WebSocket subscriptions cap at **10 unique users per IP** — two fighters
per duel, so five concurrent duels. Those are external ceilings; no amount of internal
work moves them.

Simulating Hyperliquid removes them, which is the only way to discover what the system's
*own* limits are. Measured from code, in the order they are expected to bite:

| # | Ceiling | Mechanism |
|---|---|---|
| 1 | **~2–4 duels/second scored** | `DUEL_TICK_CONCURRENCY = 4` with ~14 sequential round-trips per duel. Failure mode is score staleness, counted by `hlc_pass_overrun_total` |
| 2 | **1,000 concurrent duels** | Two unbounded `select("*")` scans; PostgREST silently caps at 1,000 rows. Already caused one production defect elsewhere in the codebase |
| 3 | **~26,000 PostgREST req/s** | 13 DB round-trips per duel per 5 s pass at production flag values |
| 4 | **720,000 rows/minute** | `duel_event_coverage`, written unconditionally even for empty windows, with no retention |
| 5 | **~50 chain tx/second** | Serial settlement, one keeper EOA, no batch entrypoint on `FatCatDuelEscrowV2` |
| 6 | **40,000 queries/s** | `market-hub`, unflagged, 4 queries per watched duel per second |
| 7 | **~2 min pool refresh** | `bet-materialiser` lock-step at 200 pools/pass |
| 8 | **~8,500 Upstash cmd/s** | One rate-limiter round-trip per API request, no in-memory tier |

`docs/ARCHITECTURE.md` carries the evidence for each.

---

## Hard rules

1. **Never point this at production.** Every k6 scenario refuses known production
   hostnames, and the simulator refuses to start unless `APP_ENV=staging`.
2. **No secrets in this repository, ever.** They live in Railway and Vercel.
3. **Testnet only.** `HL_ENV` and `NEXT_PUBLIC_HL_ENV` stay on testnet.
4. **A load test needs its own Redis.** Staging and production currently share one Upstash
   instance; the rate limiter fails open, so a load test against a shared instance can
   silently strip production of rate limiting. See `docs/RUNBOOK.md` step 2.

## Status

Environment build in progress — see `docs/RUNBOOK.md` for what is done and what is
blocked on account access.
