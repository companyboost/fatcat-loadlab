// 03 — SPECTATOR FAN-OUT. One duel, 1k → 10k → 20k spectators.
//
// THE ASSERTION THAT MATTERS:
//
//     Origin requests per duel must stay FLAT as viewer count rises.
//
// If origin load scales with viewers, caching is not working — regardless of
// what the headers claim. That assertion is the entire point of this file; the
// latency numbers are secondary.
//
// Today the audit predicts a straight 20x: there is no cache header on any duel
// route and no shared snapshot (docs/audit/00-evidence.md #32, 02-bottlenecks §5).
// This scenario exists to MEASURE that, then to prove the Phase-1 fix.
//
// Requires ~20,000 VUs at the top step. See loadtest/README.md — a single
// generator cannot do this.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { baseUrl, duelId, CADENCE, HEADERS } from './lib/config.js';
import { checkMoneyInvariants } from './lib/invariants.js';

export const snapshotLatency = new Trend('snapshot_latency', true);
export const edgeHits = new Rate('edge_cache_hit');
export const originRequests = new Counter('origin_requests');

export const options = {
  discardResponseBodies: false,
  scenarios: {
    spectators: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 1000 },
        { duration: '10m', target: 1000 },   // step 1 — record origin rate here
        { duration: '3m', target: 10000 },
        { duration: '10m', target: 10000 },  // step 2 — origin rate MUST match step 1
        { duration: '3m', target: 20000 },
        { duration: '10m', target: 20000 },  // step 3 — origin rate MUST match step 1
        { duration: '2m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    'snapshot_latency': ['p(99)<150'],       // at the edge
    'http_req_failed': ['rate<0.01'],
    'edge_cache_hit': ['rate>0.99'],         // 20k viewers, 1 object
    'money_invariant_violations': ['count==0'],
  },
};

export function setup() {
  return { base: baseUrl(), id: duelId() };
}

export default function (data) {
  // The three reads a spectator actually makes, at the app's real cadences.
  // Modelled as one VU = one viewer, with the duel read as the anchor.
  const res = http.get(`${data.base}/duels/${data.id}`, HEADERS);
  snapshotLatency.add(res.timings.duration);
  check(res, { 'duel 200': (r) => r.status === 200 });

  // Edge hit detection. Absence of the header is itself the finding today:
  // there is no CDN in front of Railway (docs/audit/05-edge-and-gateway.md).
  const cf = res.headers['Cf-Cache-Status'] || res.headers['X-Cache'] || '';
  const hit = /HIT/i.test(cf);
  edgeHits.add(hit);
  if (!hit) originRequests.add(1);

  // Chat is the highest request COUNT per viewer; include it or the model
  // understates load by ~40%.
  if (__ITER % Math.round(CADENCE.chat / CADENCE.duel) === 0) {
    http.get(`${data.base}/duels/${data.id}/chat?since=0&limit=50`, HEADERS);
  }
  if (__ITER % Math.round(CADENCE.pulse / CADENCE.duel) === 0) {
    http.get(`${data.base}/duels/${data.id}/pulse`, HEADERS);
  }

  sleep(CADENCE.duel);
}

export function teardown(data) {
  checkMoneyInvariants(data.base, { operatorToken: __ENV.OPERATOR_TOKEN });
  console.log(
    '[fanout] Compare origin_requests/sec across the three hold windows. ' +
      'Flat = caching works. Proportional to VUs = it does not.',
  );
}
