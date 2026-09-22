# fatcat-loadlab

Staging and load-testing harness for FatCat Arena: a Hyperliquid simulator, a k6 load
suite, and the environment runbook.

This repository contains **no product source code and no credentials.** It is the harness;
the system under test is deployed separately from its own repositories.

> **Why this repo is public:** Railway's GitHub integration deploys the simulator from here,
> and it cannot read a private repository. Everything in this repo is therefore written to be
> safe in the open. Operational detail about the system under test — capacity figures,
> failure modes, internal endpoints — lives in the private workspace, not here. Please keep
> it that way when adding to this repo.

---

## Why the product code is not forked here

The obvious reading of "a separate staging codebase" is to copy the backend into this repo
and point it at test infrastructure. That is the one thing this design deliberately does not
do.

A forked copy starts identical and diverges within days. Once it has, every number it
produces describes the fork rather than the product — and the whole purpose is to predict how
**production** behaves under load. A staging environment running different code is not a
staging environment; it is a second product.

Isolation is therefore achieved at the **infrastructure** layer, not the source layer. Staging
runs the same repositories and branches as production, with its own database, cache, services,
app deployment and contracts. Railway deploys a service directly from a GitHub repository, so a
separate staging project gives a backend running identical code **without any change to the
product repositories** — no new branch, no CI edit, no workflow change.

---

## Layout

```
hl-sim/     Hyperliquid simulator — REST info endpoints + WebSocket topics.
            Lets the system under test be driven past the upstream vendor's
            rate limits, which otherwise bind long before anything internal does.
k6/         Load scenarios.
docs/       RUNBOOK.md — the ordered environment build.
```

## hl-sim

```bash
cd hl-sim
npm install
APP_ENV=staging npm start          # refuses to start otherwise, by design
npm test                           # contract test — see below
```

| Endpoint | |
|---|---|
| `POST /info` | the Hyperliquid info API |
| `WS /ws` | `fastAssetCtxs`, `userFills` |
| `GET /healthz` | liveness |
| `GET /sim/metrics` | request counters and derived rates |
| `POST /sim/override` | scenario control (force an outcome, a flat account) |

Environment: `APP_ENV=staging` (required), `PORT`, and `SIM_FAULT` = `429` \| `timeout` \|
`500` for fault injection.

### The contract test is the gate

`npm test` in `hl-sim/` asserts the response shapes that, when wrong, cause the system under
test to compute a wrong answer **silently** rather than fail. Hyperliquid returns most numbers
as strings, and a wrong type there does not raise — it mis-scores.

Three defects it caught during development, each of which would have produced confident wrong
measurements:

- `userAbstraction` returns a bare JSON string, not an object.
- `fastAssetCtxs` frames are base64 of raw-DEFLATE JSON, shaped as a flat `{coin: {markPx}}`
  map, with no snapshot flag — the first message after each subscribe is positionally the full
  snapshot.
- Spot `universe.name` must equal `"@" + universe.index`, and market context joins by name,
  never by array position.

**Do not trust a run whose contract test is red.**

## Hard rules

1. **Never point this at production.** Every k6 scenario refuses known production hostnames,
   and the simulator refuses to start unless `APP_ENV=staging`.
2. **No secrets in this repository, ever.** They belong in the deployment platform.
3. **Testnet only.**
4. **Verify isolation before generating load.** `docs/RUNBOOK.md` step 9 — a staging worker
   pointed at a production resource does not error, it simply starts acting on production data.
