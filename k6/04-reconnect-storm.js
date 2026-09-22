// 04 — RECONNECT STORM. Drop and restore 50% of connections at once.
//
// Models a mobile network flap or a Railway deploy. Two things are being tested
// and only one of them is measurable from a load generator:
//
//   MEASURABLE HERE  the thundering herd. Every returning client issues a FULL
//                    snapshot read (there is no event replay — every poll is a
//                    complete duel object). With no jitter anywhere in the
//                    client (React Query resumes all intervals on
//                    visibilitychange, use-duel-api.ts:679-681), returning
//                    clients arrive PERFECTLY ALIGNED.
//
//   NOT MEASURABLE   whether animations and sound effects re-fire on a late
//                    reconnect after settlement. That is a real-device test:
//                    background a phone through settlement, foreground it five
//                    minutes later, watch duel-takeover.tsx. Marked UNKNOWN in
//                    docs/audit/00-evidence.md #36 and it stays UNKNOWN until
//                    somebody does it by hand.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { baseUrl, duelId, CADENCE, HEADERS } from './lib/config.js';
import { checkMoneyInvariants } from './lib/invariants.js';

export const reconnectLatency = new Trend('reconnect_snapshot_latency', true);
export const herdErrors = new Counter('herd_errors');

const STEADY = Number(__ENV.STEADY_VIEWERS || 4000);

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-vus',
      vus: STEADY / 2,
      duration: '15m',
      exec: 'steadyViewer',
    },
    flapping: {
      executor: 'ramping-vus',
      startVUs: STEADY / 2,
      // Half the audience vanishes, then returns ALL AT ONCE. Twice.
      stages: [
        { duration: '3m', target: STEADY / 2 },
        { duration: '1s', target: 0 },          // flap out
        { duration: '2m', target: 0 },
        { duration: '1s', target: STEADY / 2 }, // flap back, no ramp, no jitter
        { duration: '4m', target: STEADY / 2 },
        { duration: '1s', target: 0 },
        { duration: '2m', target: 0 },
        { duration: '1s', target: STEADY / 2 },
        { duration: '2m', target: STEADY / 2 },
      ],
      exec: 'flappingViewer',
      gracefulRampDown: '0s',
    },
  },
  thresholds: {
    'reconnect_snapshot_latency': ['p(99)<1000'],
    'http_req_failed': ['rate<0.02'],
    'money_invariant_violations': ['count==0'],
  },
};

export function setup() {
  return { base: baseUrl(), id: duelId() };
}

function readAll(data, trend) {
  const res = http.get(`${data.base}/duels/${data.id}`, HEADERS);
  if (trend) trend.add(res.timings.duration);
  if (res.status >= 500) herdErrors.add(1);
  check(res, { 'snapshot 200': (r) => r.status === 200 });
  // A returning client also re-hydrates chat from its cursor. sinceSeq=0 is the
  // worst case (cold client) and is what a fresh page load actually sends.
  http.get(`${data.base}/duels/${data.id}/chat?since=0&limit=50`, HEADERS);
  return res;
}

export function steadyViewer(data) {
  readAll(data, null);
  sleep(CADENCE.duel);
}

export function flappingViewer(data) {
  // __ITER === 0 is the first request after (re)connecting — the herd itself.
  readAll(data, __ITER === 0 ? reconnectLatency : null);
  sleep(CADENCE.duel);
}

export function teardown(data) {
  checkMoneyInvariants(data.base, { operatorToken: __ENV.OPERATOR_TOKEN });
  console.log(
    '[reconnect] Compare reconnect_snapshot_latency p99 against the steady-state ' +
      'duel_read_latency from 01-baseline. A large gap is the herd.',
  );
}
