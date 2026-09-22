// 08 — CHART MOUNT. 20,000 clients mounting a TradingView chart.
//
// THIS SCENARIO ASSERTS THAT ORIGIN LOAD IS ZERO — and it is a falsification
// test, not a stress test.
//
// The brief assumed "TradingView Advanced Charts ships no market data, so every
// bar is served by your backend and spectator chart load is your load."
// THAT IS FALSE FOR THIS CODEBASE. Bars are fetched by the BROWSER directly from
// Hyperliquid's candleSnapshot, with a client-side BarCache, an in-flight
// de-dupe and a client-side token bucket. There is no /history, /symbols or
// /config route on the backend at all.
//   codebase/fatcat-app/src/lib/tv/bar-request.ts:10-18
//   codebase/fatcat-app/src/lib/hyperliquid/clients.ts:14-15
//   docs/audit/00-evidence.md #33
//
// So this file does two things:
//   1. Proves the negative: confirm the backend serves no bar data, so that if
//      someone later adds a /history proxy (docs/audit/05-edge-and-gateway.md
//      says DO NOT), this test fails loudly and says why.
//   2. Models what the chart mount ACTUALLY costs — a burst of candleSnapshot
//      calls against Hyperliquid from many client IPs — so the HL-side risk is
//      quantified rather than assumed away.
//
// ⚠️ Part 2 sends traffic to Hyperliquid, NOT to staging. Run it against the
//    HL TESTNET endpoint only, and keep HL_CLIENTS low. Do not point a
//    distributed k6 fleet at a third party's mainnet API.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { baseUrl, HEADERS } from './lib/config.js';

export const originBarRequests = new Counter('origin_bar_requests');
export const hlCandleLatency = new Trend('hl_candle_latency', true);
export const hl429 = new Counter('hl_429');

const HL_INFO = __ENV.HL_INFO_URL || 'https://api.hyperliquid-testnet.xyz/info';
const HL_CLIENTS = Number(__ENV.HL_CLIENTS || 50);

export const options = {
  scenarios: {
    // Part 1 — the assertion. One VU is enough; this is a shape check.
    proveNoOrigin: {
      executor: 'shared-iterations',
      vus: 1, iterations: 1,
      exec: 'proveNoOrigin',
    },
    // Part 2 — model the real cost, deliberately small.
    hlMount: {
      executor: 'constant-vus',
      vus: HL_CLIENTS,
      duration: '5m',
      exec: 'hlMount',
      startTime: '10s',
    },
  },
  thresholds: {
    // If this ever fires, someone added a backend datafeed. Read
    // docs/audit/05-edge-and-gateway.md before "fixing" the test.
    'origin_bar_requests': ['count==0'],
    'hl_429': ['count==0'],
  },
};

export function setup() {
  return { base: baseUrl() };
}

export function proveNoOrigin(data) {
  // The three routes a TradingView UDF datafeed would need, if one existed.
  for (const path of ['/history?symbol=BTC&resolution=1&from=0&to=1', '/symbols?symbol=BTC', '/config']) {
    const res = http.get(`${data.base}${path}`, HEADERS);
    const exists = res.status !== 404;
    check(res, { [`${path} does not exist on the backend`]: () => !exists });
    if (exists) {
      originBarRequests.add(1);
      console.error(
        `[UNEXPECTED] ${path} returned ${res.status}. A backend datafeed now exists — ` +
          'chart load has moved from Hyperliquid onto the origin. This changes ' +
          'docs/audit/02-bottlenecks.md §5 materially and needs an edge cache strategy.',
      );
    }
  }
}

export function hlMount(data) {
  // What one chart mount costs: planBarWindows walks newest-first, up to 5 pages
  // of <=5,000 candles (bar-request.ts:11,18). A cold mount at 1m resolution
  // asking for ~350 bars is ONE page.
  const to = Date.now();
  const from = to - 350 * 60_000;
  const res = http.post(
    HL_INFO,
    JSON.stringify({
      type: 'candleSnapshot',
      req: { coin: 'BTC', interval: '1m', startTime: from, endTime: to },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  hlCandleLatency.add(res.timings.duration);
  if (res.status === 429) hl429.add(1);
  check(res, { 'HL candleSnapshot ok': (r) => r.status === 200 });

  // A real client then sits on a WebSocket for live bars and does not re-poll.
  // 60s here models "mounted, then idle", which is the honest steady state.
  sleep(60);
}

export function teardown() {
  console.log(
    '[chart-mount] Expected: origin_bar_requests == 0, and HL absorbing the mount burst ' +
      'across many client IPs. Record hl_candle_latency — it is the number that decides ' +
      'whether the fallback datafeed in 02-bottlenecks.md F-10 is ever needed.',
  );
}
