# Staging environment runbook

Builds an environment that shares **nothing** with production, running **identical product
code**. Steps are ordered: several later steps are unsafe if an earlier one is skipped, and
each one says why.

Legend: ✅ done · ⏳ in progress · 🔒 blocked on account access · ⬜ not started

---

## Step 0 — the isolation contract ✅

Write this down before provisioning, because the failure mode is silent and expensive: a
staging worker pointed at a production resource does not error, it just starts acting on
production data. Settlement loops do not know they are in staging.

| Resource | Production | Staging must be |
|---|---|---|
| Supabase project | `rnianopzibnxuyycsqau` | **a different project ref** |
| Upstash Redis | (prod instance) | **a different instance** |
| Railway project | `modest-balance` (John Israel's Projects) | **a different project** |
| Vercel project | `fatcat-app` | **a different project** |
| Escrow / vault / custody | prod Arbitrum Sepolia addresses | **freshly deployed addresses** |
| Keeper / faucet / distributor wallets | prod keys | **fresh wallets** |
| Privy | prod app | **a separate app** (also solves `frame-ancestors`) |
| Hyperliquid | real testnet | **the simulator** |

> **The single highest-consequence check in this document:** after the environment is up,
> confirm staging's `SUPABASE_URL` and `ESCROW_ADDRESS` differ from production's. Step 9
> automates it. Do not run a load test before it passes.

---

## Step 1 — new Railway project 🔒 **blocked**

The staging backend runs the *same* repository as production. Railway deploys a service
directly from GitHub, so this needs **no change to `fatcat-backend`** — no branch, no CI
edit, no `staging` branch push.

```bash
# Run from THIS repo's directory, never from codebase/fatcat-backend —
# `railway init` links the current directory, and linking the shared checkout
# could redirect a teammate's deploy to the wrong project.
railway init --name fatcat-staging --workspace "<workspace>" --json
```

Then two services, both from `companyboost/fatcat-backend` @ `main`:

| Service | `SERVICE_ROLE` | Replicas | Public domain | Start command |
|---|---|---|---|---|
| `fatcat-backend` | `api` | 1 | yes | `pnpm start` |
| `fatcat-worker` | `worker` | **1** | **no** | `pnpm start:worker` |

**`numReplicas: 1` on the worker is load-bearing, not tidiness.** Four loops — `mark-stream`,
`fill-stream`, `hl-consumer`, `spot-liquidity-probe` — take **no distributed lock**
(`worker-runtime.ts:62-74`); `claimExclusiveOwnership` is a tripwire, not a mutex. A second
replica silently duplicates every `pnl_snapshots` row, because `sampled_at` is computed
per-replica so the unique constraint never fires.

Set the start command **in the dashboard**. Railway retired config-as-code opt-in for new
services, so `railway.json` / `railway.worker.json` in the repo are read by nothing — this is
already true of the production services, which run RAILPACK while the repo files say NIXPACKS.

**Blocked:** the CLI account (`companyboost@gmail.com`) cannot create projects in *John
Israel's Projects*, and project creation in its own workspace requires a permission grant in
this session. See "Access still required" below.

---

## Step 2 — dedicated Upstash Redis 🔒 **blocked on account access**

**Do this before any load is generated.** Staging and production currently point at the
*same* Upstash instance — verified by comparing the two `UPSTASH_REDIS_REST_URL` values
directly. Isolation today is a key prefix (`fc:<env>:<network>:`, `redis.ts:16-27`), not an
instance.

That is a correctness convention, not isolation. Two consequences:

1. The two environments share one **command-per-second quota**. Upstash *throttles* rather
   than rejects when a cap is hit.
2. The IP rate limiter **fails open** (`rate-limit.ts:75`, deliberate and documented). So a
   throttled Redis does not produce errors — it produces **production silently serving with
   no rate limiting at all**, during the exact window we are hammering staging.

Provision a new database, then set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
on both staging services.

---

## Step 3 — staging Supabase ⬜

A staging project already exists (`efocaprpwvcpwobonlgm`) and is alive, but its schema state
is **unknown** and almost certainly ~August: the `staging` branch carries 45 migration files
against `main`'s 82, and **no CI workflow applies migrations** — `deploy.yml` only typechecks,
tests, builds and deploys.

Decide first: reuse it, or create a clean one. Reuse is faster; a clean project is the only
way to be sure of what is in it.

⚠️ **`supabase db push` cannot be trusted here.** Production records 36 migrations while the
repo has 82 and production demonstrably contains tables from migrations applied by hand. The
ledger does not describe the schema. Either backfill `supabase_migrations.schema_migrations`
or squash a single baseline **before** relying on a push, or staging's schema will silently
differ from production's in ways no test will catch.

---

## Step 4 — the Hyperliquid simulator ⏳

Deploy `hl-sim/` (this repo) as a third Railway service in the staging project, no public
domain, then on both backend services:

```
HL_API_URL   = http://hl-sim.railway.internal:8080     # REST
HL_WS_URL    = ws://hl-sim.railway.internal:8080/ws    # WebSocket — see below
```

⚠️ **`HL_API_URL` covers REST only.** It is applied at `hl-transport.ts:125`, but *both*
WebSocket transports — `mark-stream.ts:81` and `fill-stream.ts:228` — construct
`new WebSocketTransport({ isTestnet })` with **no URL override**. Left as-is, the mark stream
keeps talking to real Hyperliquid, and the mark stream gates whether snapshot rows are written
at all, so the simulator would appear to work while scoring silently depended on the real
venue.

Good news from the contract extraction: **the SDK already supports this.**
`WebSocketTransport` accepts `options.url` and uses it verbatim with no path suffix
(`esm/transport/websocket/mod.js:66-68`), falling back to `isTestnet` when absent. So the
change in `fatcat-backend` is genuinely small and purely additive:

```ts
// src/lib/env.ts, beside HL_API_URL at :283
HL_WS_URL: opt("HL_WS_URL"),

// src/lib/mark-stream.ts:81 and src/lib/fill-stream.ts:228, in both constructors
...(env.HL_WS_URL ? { url: env.HL_WS_URL } : {}),
```

Spread, so an unset value leaves today's behaviour byte-for-byte unchanged. Worth considering a
shared `makeWsTransport()` alongside `makeInfoClient()` so a third call site cannot be added
unrouted — that is a plan decision, not a drive-by.

> ⚠️ **`HL_API_URL` does not catch everything either.** It is honoured only by
> `makeInfoClient()`. Two other `HttpTransport`s are constructed without it and will still reach
> the real venue from staging: `src/lib/hl-faucet.ts:17` and
> `src/lib/prediction-return-worker.ts:326`. Route them through the same override, or disable the
> faucet and the return worker on staging. Left as-is, staging quietly consumes production's
> Hyperliquid budget — the precise failure this environment exists to avoid.

### Contract test — the gate on trusting any of this ✅

`hl-sim` ships `test/contract.test.js`, which pins the shapes that break the backend *silently*
rather than loudly. **10/10 passing**, and verified red-then-green against a real bug (see below).
Run `npm test` in `hl-sim/` before trusting any measurement.

Three genuine defects it caught in the first draft, all of which would have produced confident
wrong numbers:

1. **`userAbstraction` returns a bare JSON string**, not an object. An object normalises to
   `unknown`, and `hl-consumer.ts:432` then throws `unsupported Hyperliquid account mode` on
   every pass, aborting each fighter snapshot. Shown red:
   `AssertionError: an object here throws 'unsupported Hyperliquid account mode'`.
2. **`fastAssetCtxs` frames are base64 of raw-DEFLATE JSON**, on channel `fastAssetCtxs`, shaped
   as a flat `{coin: {markPx}}` map with **no `isSnapshot` flag** — the first message after each
   subscribe is positionally the full snapshot, and `mark-stream` clears its whole map on it.
   Plain JSON here means no mark ever lands and every score reads `mark_stale`.
3. **Spot `universe.name` must equal `"@" + universe.index`** (`hl-consumer.ts:383`), and
   `ctx.coin` joins by name, never by array position. The draft numbered indices 0..n while
   naming pairs `@476`, so the consumer's equity walk skipped every market.

Two more rules the test enforces, because both fail quietly:

- Every monetary string must survive `parseScaled`'s strict regex (`duel-score.ts:32`) — no
  exponent notation, no leading `+`, no empty string. A failure yields `basis_unreadable` and a
  frozen score, not an error.
- `userNonFundingLedgerUpdates` must default to `[]`. Any transfer-type delta inside a duel
  window parks **every** duel in `review_required`.

---

## Step 5 — staging escrow ⬜

Deploy `FatCatDuelEscrowV2`, `FatCatBetVault` and prediction custody fresh to Arbitrum Sepolia.
Staging's recorded `ESCROW_ADDRESS` is `0x180bE333…`, the July split-owner V2, long superseded.

**Fund the staging keeper wallet and watch its balance.** Nothing monitors keeper gas; an empty
keeper produces "MATCH COULD NOT START" with no other signal, and a frozen nonce means the
transaction was never broadcast.

---

## Step 6 — staging variables ⬜

Staging carries **26** variables; production's API carries 64 and its worker 80. Missing
entirely from staging: `SERVICE_ROLE`, `HL_ENV`, and the whole betting / prediction /
gamification / keeper / faucet / Phase-1 flag families.

⚠️ **Do not bulk-copy production variables.** The set contains `SUPABASE_URL`,
`ESCROW_ADDRESS` and live keeper keys; copying wholesale points staging's worker at
production's database and escrow, and it will begin settling real duels. Copy flag-by-flag and
substitute every resource identifier per Step 0.

Non-negotiable in staging: `HL_ENV=testnet`, `MAINNET_MONEY_ENABLED=false`,
`APP_ENV=staging`, and `LOADTEST_METRICS=1` (staging is where measurement belongs; it is
currently **off in production**, which is why no live Hyperliquid weight number exists).

Match production's Phase-1 flags so staging measures the same code path:
`HLC_INSERT_ONCE=true`, `HLC_LEGACY_FILLS_FROM_LEDGER=true`, `DUELS_SCORE_RPC_ENABLED=true`,
`DUEL_SNAPSHOT_TTL_MS=2000`, `DUEL_STREAM_ENABLED=true`, `FILL_STREAM_ENABLED=true`,
`MARK_IDLE_PROBE_MS=10000`, `SPOT_LIQUIDITY_IDLE_PROBE_MS=60000`. Leave
`TICK_SCAN_PUSHDOWN`, `HLC_ACCOUNT_MODE_TTL_MS` and `PNL_SNAPSHOT_RETENTION_DAYS` unset, as
production has them.

---

## Step 7 — staging app ⬜

A new Vercel project from `dukestudios/fatcat-app` @ `main`, on
`staging-app.fatcatarena.xyz`.

- **Not `staging.fatcatarena.xyz`** — that host is the `fatcat-ui` marketing showcase.
- All ~43 `NEXT_PUBLIC_*` are **baked at build time**, so staging needs its own build, not just
  its own runtime env. Production env is Production-scoped, so inject as **both** `--build-env`
  and `--env` or the build silently takes empty values.
- Add the staging origin to the staging backend's `APP_ORIGINS`, or every call fails CORS with
  a 204 and no `access-control-allow-origin`.

🔒 **Privy blocks login until changed.** `frame-ancestors` permits only `localhost:3000`,
`app.fatcatarena.xyz` and `fatcat-app.vercel.app`. A new origin cannot complete a login. Give
staging its own Privy app — which also stops it sharing production's user pool.

---

## Step 8 — observability ⬜

- Add staging to `health-watch.yml`.
- Add a **staleness alarm** comparing staging `/health.commit` against `origin/main`. The
  existing staging environment sat 27 days and 138 commits stale precisely because nothing
  watched it.
- Confirm `/health.metrics` is present (it needs `LOADTEST_METRICS=1`).

---

## Step 9 — verify isolation before any load ⬜

`scripts/verify-isolation.sh`. Every check must pass:

1. Staging `/health` → `environment: "staging"`, `network: "testnet"`.
2. Staging `SUPABASE_URL` ≠ production's.
3. Staging `UPSTASH_REDIS_REST_URL` ≠ production's.
4. Staging `ESCROW_ADDRESS` ≠ production's.
5. Two services: `role: "api"` with `runsWorkers: false`, plus a worker publishing
   `workerConfig`.
6. All worker heartbeats fresh.
7. `/health.metrics` present.
8. Simulator reachable; `hl_requests_total` climbing on staging while **production's is flat**.
9. Production `/health` `uptimeSec` **unchanged** across the whole exercise — proof nothing
   touched it.

---

## Access still required

| # | Need | Why | Who |
|---|---|---|---|
| 1 | **Railway project creation** | Blocked twice: no create permission in *John Israel's Projects*, and a permission grant is needed for the account's own workspace | John / session permission |
| 2 | **Upstash: a new database** | Step 2. Blocking for load tests specifically | John |
| 3 | **Staging Supabase credential** | Its schema cannot even be inspected today. `.envrc` resolves secrets through a macOS keychain helper that yields empty strings on Windows; there is no `.env.secrets`, no Supabase CLI and no `psql` | John |
| 4 | **Privy: staging app or allowed origin** | Step 7 — no login without it | John |
| 5 | **Which workspace / who pays** | A 10k-duel run is real compute. Decide before provisioning | user |

> Item 3 has a tempting shortcut that was deliberately **not** taken: the staging Supabase
> service-role key is readable from Railway's staging variables — but reading them also dumps
> `ESCROW_KEEPER_PRIVATE_KEY` and similar into a transcript. Ask for the one key instead.
