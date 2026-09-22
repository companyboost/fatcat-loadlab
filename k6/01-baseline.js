// 01 — BASELINE. Run this first. NEVER delete the results.
//
// Every other scenario is read relative to this one. It models today's observed
// peak, which the audit measured as: 0 live duels, 388 lifetime notifications
// (docs/audit/00-evidence.md §8). BASELINE_VIEWERS therefore defaults to a
// deliberately small number — raise it only to a figure you can cite.
//
//   SOAK=1  →  4-hour hold, for memory/connection/cursor leaks.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { baseUrl, CADENCE, HEADERS } from './lib/config.js';
import { checkMoneyInvariants } from './lib/invariants.js';

const VIEWERS = Number(__ENV.BASELINE_VIEWERS || 10);
const SOAK = __ENV.SOAK === '1';

export const duelReadLatency = new Trend('duel_read_latency', true);
export const hubReadLatency = new Trend('hub_read_latency', true);

export const options = {
  scenarios: {
    hub: {
      executor: 'constant-vus',
      vus: VIEWERS,
      duration: SOAK ? '4h' : '10m',
    },
  },
  thresholds: {
    // Deliberately loose. A baseline exists to be RECORDED, not to pass a bar
    // that was invented before any measurement existed.
    http_req_failed: ['rate<0.01'],
    money_invariant_violations: ['count==0'],
    stalled_duels: ['count==0'],
  },
};

export function setup() {
  const base = baseUrl();
  const health = http.get(`${base}/health`);
  check(health, { 'staging is healthy': (r) => r.status === 200 });
  return { base, startedAt: Date.now() };
}

export default function (data) {
  const res = http.get(`${data.base}/duels/live`, HEADERS);
  hubReadLatency.add(res.timings.duration);
  check(res, { 'hub 200': (r) => r.status === 200 });

  const duels = res.status === 200 ? res.json('duels') || [] : [];
  for (const d of duels.slice(0, 3)) {
    const one = http.get(`${data.base}/duels/${d.id}`, HEADERS);
    duelReadLatency.add(one.timings.duration);
    check(one, { 'duel 200': (r) => r.status === 200 });
  }

  sleep(CADENCE.live);
}

export function teardown(data) {
  const violations = checkMoneyInvariants(data.base, {
    operatorToken: __ENV.OPERATOR_TOKEN,
  });
  console.log(
    `[baseline] ${VIEWERS} viewers, ${SOAK ? 'soak' : 'short'} run, ` +
      `${violations.length} invariant violation(s)`,
  );
}
