# Staging environment runbook

Builds an environment that shares **nothing** with production while running **identical
product code**. Steps are ordered; several later steps are unsafe if an earlier one is
skipped.

> This is the public, operational copy. Capacity figures, internal failure modes and the
> specific weaknesses this environment exists to measure are kept in the private workspace
> (`docs/audit/STAGING-RUNBOOK-internal.md`), not here.

Legend: ✅ done · ⏳ in progress · 🔒 blocked on account access · ⬜ not started

---

## Step 0 — the isolation contract ✅

Write this down before provisioning. The failure mode is silent: a staging worker pointed at a
production resource does not error, it starts acting on production data. Settlement loops do
not know which environment they are in.

Every one of these must differ from production: database project, cache instance, platform
project, app deployment, contract addresses, keeper/faucet wallets, auth application, and the
market-data upstream (the simulator).

> **Highest-consequence check in this document:** once the environment is up, confirm the
> database URL and contract addresses differ from production's. Step 9 automates it. Do not
> generate load before it passes.

---

## Step 1 — platform project ⏳

The staging backend runs the *same* repository as production. Railway deploys from GitHub
directly, so this needs **no change to the product repositories** — no branch, no CI edit.

```bash
# Run from THIS repo's directory, never from a product checkout —
# `railway init` links the current directory, and linking a shared checkout
# could redirect a teammate's deploy to the wrong project.
railway init --name fatcat-staging --workspace "<workspace>" --json
```

Two services, both from the backend repo at `main`:

| Service | `SERVICE_ROLE` | Replicas | Public domain |
|---|---|---|---|
| `fatcat-backend` | `api` | 1 | yes |
| `fatcat-worker` | `worker` | **1** | no |

**One replica on the worker is load-bearing, not tidiness.** Several background loops hold no
distributed lock; the ownership record is a tripwire, not a mutex. A second replica silently
duplicates score history rather than erroring.

Set the start command **in the dashboard**. Railway retired config-as-code opt-in for new
services, so `railway.json` files in the repo are read by nothing — already true of the
existing services, which run RAILPACK while the repo files say NIXPACKS.

**Status:** a dedicated project could not be created — the personal workspace's trial has
expired, and the account cannot create projects in the paid workspace. Work is proceeding in
the paid project's existing `staging` environment, which is isolated from production at the
service and variable level.

---

## Step 2 — dedicated cache instance 🔒

**Do this before any load is generated.** Staging and production currently point at the *same*
Upstash instance; isolation today is a key prefix, not an instance. They therefore share one
command-per-second quota, and the rate limiter fails **open** — so exhausting that quota from
staging degrades production silently rather than visibly.

Provision a new database and set `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` on both
staging services.

---

## Step 3 — staging database ⬜

A staging project exists but its schema is well behind `main`, and **no CI workflow applies
migrations** — the deploy pipeline only typechecks, tests, builds and deploys. Whatever is
there was applied by hand.

⚠️ **A plain `db push` cannot be trusted.** The recorded migration ledger does not describe the
actual schema, because later migrations were applied manually. Backfill the ledger or squash a
baseline **before** relying on a push, or staging's schema will differ from production's in
ways no test catches.

⚠️ **Sequencing:** bring the schema current *before* deploying current `main` here. Code from
`main` expects tables a stale database does not have, and the result is a crash-looping worker.

---

## Step 4 — the Hyperliquid simulator ⏳

Deploy `hl-sim/` as a service in the staging environment, no public domain, then on both
backend services:

```
HL_API_URL = http://hl-sim.railway.internal:8080      # REST
HL_WS_URL  = ws://hl-sim.railway.internal:8080/ws     # WebSocket
```

⚠️ **`HL_API_URL` covers REST only.** Both WebSocket transports are constructed without a URL
override, so left alone the mark stream keeps talking to the real venue — and the mark stream
gates whether score rows are written at all. The simulator would appear to work while scoring
silently depended on the real upstream.

The SDK already supports this: `WebSocketTransport` accepts a `url` option and uses it verbatim,
falling back to its default when absent. The backend change is small and purely additive — add
an `HL_WS_URL` environment option and spread it into both transport constructors, so an unset
value leaves current behaviour unchanged. It is the **only product-repo edit in this plan** and
needs its own PR.

⚠️ **`HL_API_URL` does not catch every caller either.** It is honoured only by the shared info
client factory; two other HTTP transports are built without it and will still reach the real
venue from staging. Route them through the same override, or disable the faucet and the return
worker on staging.

### Contract test ✅

`hl-sim` ships `test/contract.test.js`, pinning the shapes that break the system under test
*silently* rather than loudly. **10/10 passing**, verified red-then-green against a real bug.
Run `npm test` in `hl-sim/` before trusting any measurement. See the README for what it caught.

---

## Step 5 — staging contracts ⬜

Deploy escrow, vault and prediction custody fresh to the testnet. Staging's recorded escrow
address is months old and superseded.

**Fund the staging keeper wallet and monitor its balance.** Nothing watches keeper gas; an empty
keeper fails with a generic "could not start" message and no other signal.

---

## Step 6 — variables ⬜

Staging carries far fewer variables than production and is missing whole feature-flag families,
so it currently rehearses neither production's topology nor its configuration.

⚠️ **Do not bulk-copy production variables.** The set contains database URLs, contract addresses
and live keeper keys; copying wholesale points staging's worker at production's database and
contracts, and it will begin settling real activity. Copy flag-by-flag and substitute every
resource identifier per Step 0. Where the platform supports cross-service variable references,
prefer them — they avoid materialising a secret anywhere.

Non-negotiable in staging: testnet mode, mainnet money disabled, `APP_ENV=staging`, and metrics
enabled (staging is where measurement belongs).

Match production's feature flags so staging exercises the same code path; leave flags that are
off in production off here too, or the two environments diverge in behaviour.

---

## Step 7 — staging app ⬜

A new Vercel project from the app repo at `main`, on its own subdomain.

- Client environment variables are **baked at build time**, so staging needs its own build, not
  just its own runtime environment. Production-scoped variables must be injected as **both**
  build-time and runtime or the build silently takes empty values.
- Add the staging origin to the staging backend's allowed-origins list, or every call fails CORS
  with no `access-control-allow-origin` header.

🔒 **Auth blocks login until changed.** The auth provider's frame-ancestors policy permits only
a fixed set of origins; a new one cannot complete a login. Give staging its own auth
application, which also stops it sharing production's user pool.

---

## Step 8 — observability ⬜

- Add staging to the health-watch workflow.
- Add a **staleness alarm** comparing the deployed commit against the repository head. The
  previous staging environment sat months stale precisely because nothing watched it.
- Confirm the metrics block is present on `/health`.

---

## Step 9 — verify isolation before any load ⬜

Every check must pass:

1. Staging health reports the staging environment and testnet.
2. Staging database URL ≠ production's.
3. Staging cache URL ≠ production's.
4. Staging contract addresses ≠ production's.
5. Two services: an API reporting it runs no workers, plus a worker publishing its config.
6. All worker heartbeats fresh.
7. Metrics present.
8. Simulator reachable, and its request counter climbing **while production's upstream traffic
   stays flat**.
9. Production health uptime **unchanged** across the whole exercise — proof nothing touched it.
