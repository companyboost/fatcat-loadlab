# FatCat load tests

> ## ⛔ NOTHING IN HERE HAS BEEN RUN.
>
> Audit guardrail 6: *"Run load tests against staging only. If you cannot confirm from config
> which environment a URL points at, stop and ask."*
>
> The only backend URL discoverable from this workspace is
> `https://fatcat-backend-production.up.railway.app`, and it self-reports
> `{"environment":"production"}`. **No staging backend URL exists in any config file, env file,
> CI workflow, or document in this repository.** Every script therefore refuses to start unless
> `BASE_URL` is set explicitly *and* does not match a production hostname.
>
> **Update 2026-08-25:** a staging backend DOES exist — it was simply not referenced in any repo
> file. **`BASE_URL=https://fatcat-backend-staging.up.railway.app`** (self-reports
> `"environment":"staging"`). It deploys from the `staging` branch of `companyboost/fatcat-backend`
> via `deploy.yml` (`RAILWAY_TOKEN_STAGING`); to put `main` on it, fast-forward `staging` to `main`.
> The Railway project lives under `john@fatcatarea.xyz`, the Supabase projects under
> `companyboost@gmail.com`. Neither is reachable from this workspace (no CLI, no tokens) — variable
> changes such as `HL_API_URL` are flipped by hand in the Railway UI.

---

## Why k6

Chosen against the alternatives on properties this system specifically needs:

- **Protocol coverage that matches the architecture.** Everything here is HTTP/1.1 and HTTP/2
  polling (`docs/audit/00-evidence.md` #20-22) — no WebSocket, no SSE. k6 covers those natively
  today *and* covers SSE and WebSocket, so the same harness survives the Phase-1 fan-out work
  without a tool migration.
- **Thresholds produce non-zero exit codes**, so every scenario here is CI-gateable as written.
- **Kubernetes operator for distributed runs**, which is mandatory here (see below).
- **JavaScript.** This is a TypeScript/Node shop; the scripts are reviewable by the people who
  own the code.

**Gatling** is the credible alternative — JVM, also covers SSE and WebSocket, stronger built-in
HTML reporting. It was not chosen only because it adds a JVM toolchain to a repo that has none.

**Neither drives real browsers at meaningful scale.** These scripts model *protocol-level* load.
Client behaviour — React Query interval resumption, iOS timer suspension, TradingView chart mount,
animation re-fire on late reconnect — must be tested separately with real devices.

---

## ⚠️ A single load generator will not produce 20,000 connections

Practical ceilings per generator: **~1,500–4,000** concurrent k6 VUs on a 4 vCPU / 8 GB host,
lower for connection-heavy scenarios. Scenario `03-spectator-fanout.js` at its top step needs
**20,000**.

### Distributed run

**Option 1 — k6 Operator on Kubernetes (recommended).**

```bash
kubectl apply -f https://github.com/grafana/k6-operator/releases/latest/download/bundle.yaml
kubectl create configmap fatcat-loadtest --from-file=loadtest/
# parallelism: 10  ⇒  10 pods × 2,000 VUs = 20,000
kubectl apply -f k6-testrun.yaml
```

k6 splits `scenarios` across pods automatically. **Set `--tag runner=$INSTANCE_ID`** so per-pod
metrics are separable — you need this to tell "one generator saturated" from "the origin
saturated", which is the single most common false conclusion in a distributed load test.

**Option 2 — Grafana Cloud k6.** No infrastructure; costs per VU-hour.

**Option 3 — N EC2/Hetzner hosts.** Run the same script with `--execution-segment`:

```bash
k6 run -e BASE_URL=$STAGING --execution-segment "0:1/10"   --execution-segment-sequence "0,1/10,2/10,...,1" 03-spectator-fanout.js
```

### Generator-side prerequisites (skip these and you will measure your own laptop)

```bash
ulimit -n 200000                                    # fd limit — the #1 cause of fake failures
sysctl -w net.ipv4.ip_local_port_range="1024 65535" # ephemeral ports
sysctl -w net.ipv4.tcp_tw_reuse=1
```

**Egress IPs matter here more than usual.** `IP_RATE_LIMITS.read` is 1,200/min **per client IP**
(`codebase/fatcat-backend/src/lib/ip-rate-limit.ts:34`). A generator behind one NAT will start
receiving 429s at ~23 simulated viewers and you will measure the rate limiter, not the system.
Either run generators across many source IPs, or raise the limit on staging for the run window and
**say so in the results**.

---

## Instrument the backend first

**Every threshold below is unverifiable without this, and it must ship before the first run.**
All of it is behind `LOADTEST_METRICS=1`, defaults **off**, and changes no business behaviour
(audit guardrail 3).

| Metric | Where it goes | Why it is on this list |
|---|---|---|
| HL weight consumed/min per egress IP, and remaining budget via `userRateLimit` | new `src/lib/hl-budget.ts` | **The #1 gap.** `userRateLimit` is never called today (`00-evidence.md` #13), which is why the 2.1×-over-budget condition has never been noticed |
| Tick pass duration per stage, and lock wait time | `settlement-engine.ts:167-197` | the tick has no timing at all |
| Redis commands/sec and pipeline batch sizes | `lib/redis.ts` wrapper | Upstash ceiling is a headline risk |
| Keeper queue depth, submit→confirm latency, stuck-tx count | `escrow-keeper.ts:166` | quantifies F-2 |
| Connections held, messages/sec, bytes/sec, serialise time | Hono middleware | Scenario C |
| Snapshot endpoint **origin** hit rate vs **edge** hit rate | edge analytics + origin counter | the assertion in Scenario 3 depends on both halves |
| Postgres rows written/sec per table, PostgREST latency | `lib/supabase.ts` wrapper | quantifies F-6 |

---

## Scenarios

| File | Models | The question it answers |
|---|---|---|
| `01-baseline.js` | today's observed peak | **Run first. Never delete the results.** Everything else is relative to this. |
| `02-duel-ramp.js` | 100 → 1,000 → 5,000 → 10,000 duels, 30 min hold/step | **The point is to find the ceiling, not to pass.** Record the exact step where each subsystem breaks. Prediction from the audit: the HL scoring loop degrades between 20 and 50 duels, long before step 1 completes. |
| `03-spectator-fanout.js` | one duel, 1k → 10k → 20k spectators | Does origin request rate stay **flat** as viewers rise? |
| `04-reconnect-storm.js` | drop and restore 50 % of connections at once | Thundering herd; snapshot cost; do animations re-fire? |
| `05-settlement-burst.js` | 2,000 duels ending in one 60 s window | Predicted ~2 h 13 m of serialised chain waiting (`02-bottlenecks.md` §4) |
| `06-hl-degraded.js` | HL 429/timeout for 5 minutes | **No duel settles incorrectly and none silently stalls.** |
| `07-bet-burst.js` | ~100 bets/s on one pool | Skeleton only — the endpoints do not exist yet |
| `08-chart-mount.js` | 20,000 clients mounting a chart | Asserts origin load is **zero** — `00-evidence.md` #33 |

Test types: **Baseline** · **Load** · **Stress** · **Spike** · **Soak** (run `01-baseline.js` with
`SOAK=1` for 4 h+ to catch memory leaks, connection leaks and stale cursors — the module-level
`fillCursorMs` / `eventCursorMs` maps in `hl-consumer.ts:32-33` grow without bound and have never
been observed over a long run).

---

## Threshold gates

Tuned once the baseline exists. Written as k6 thresholds so a breach is a non-zero exit code.

- tick pass p99 **< 5 s** per shard; **zero** shard starvation over 30 min
- HL weight **< 70 %** of budget on **every** egress IP
- **zero** duels stalled > 2 min at `matched` or `proposed`
- snapshot origin rate **flat** vs viewer count; p99 **< 150 ms** at edge
- **zero money-invariant violations** — `checkMoneyInvariants()` runs after **every** scenario

---

## Running

```bash
export BASE_URL="https://<staging-backend>"      # MUST NOT be the production host
export LOADTEST_METRICS=1                        # on the backend, not here

k6 run 01-baseline.js
k6 run 02-duel-ramp.js
k6 run --out json=results/03.json 03-spectator-fanout.js
```

Every script aborts immediately if `BASE_URL` is unset or looks like production.
