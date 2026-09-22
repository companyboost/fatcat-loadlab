// 05 — SETTLEMENT BURST. 2,000 duels ending inside the same 60-second window.
//
// The realistic worst case, and the one the audit predicts will be worst:
// every keeper transaction is awaited to receipt INLINE, serially, per duel,
// inside a single global tick lock (escrow-keeper.ts:166-167, settlement-engine
// .ts:167). One keeper EOA, no nonce pipelining.
//
// AUDIT PREDICTION:
//   [DERIVED] 2,000 duels x 2 txs x [ASSUMED] 2 s = ~8,000 s ≈ 2 h 13 m of
//   serialised chain waiting, during which matchmaking, deposit detection,
//   challenge expiry and refund deadlines are ALL blocked cluster-wide.
//   Nothing errors. Nothing alerts. The system just stops.
//
// THIS SCENARIO IS PRIMARILY AN OBSERVER. The load is created by scheduling the
// duels, not by the generator. Drive duel creation with 02-duel-ramp.js using
// short (5m) rounds so they land together, then run this to watch the drain.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Gauge, Counter } from 'k6/metrics';
import { baseUrl, HEADERS } from './lib/config.js';
import { checkMoneyInvariants } from './lib/invariants.js';

export const drainTime = new Trend('settlement_drain_ms', true);
export const pendingTerminal = new Gauge('duels_awaiting_settlement');
export const stalledOver2Min = new Counter('duels_stalled_over_2min');

export const options = {
  scenarios: {
    observer: {
      executor: 'constant-vus',
      vus: 1,
      duration: __ENV.OBSERVE_FOR || '3h',   // long, because the prediction is ~2h13m
      exec: 'observe',
    },
    // Background read load, so the burst is measured under realistic pressure
    // rather than on an idle box.
    ambient: {
      executor: 'constant-vus',
      vus: Number(__ENV.AMBIENT_VIEWERS || 200),
      duration: __ENV.OBSERVE_FOR || '3h',
      exec: 'ambientViewer',
    },
  },
  thresholds: {
    // The gate the audit proposes: zero duels stalled >2 min at matched/proposed.
    'duels_stalled_over_2min': ['count==0'],
    'money_invariant_violations': ['count==0'],
  },
};

const firstSeenTerminal = {};

export function setup() {
  return { base: baseUrl(), startedAt: Date.now() };
}

export function observe(data) {
  // /duels/live only lists `active`, so the drain is measured as the DISAPPEARANCE
  // of live duels plus the operator queue for anything parked.
  const live = http.get(`${data.base}/duels/live`, HEADERS);
  if (live.status === 200) {
    const duels = live.json('duels') || [];
    const now = Date.now();
    let awaiting = 0;
    for (const d of duels) {
      // A duel past its ends_at that is still being served as live is one the
      // tick has not reached yet. That is exactly the queue depth we want.
      if (d.endsAt && d.endsAt < now) {
        awaiting += 1;
        if (!firstSeenTerminal[d.id]) firstSeenTerminal[d.id] = now;
        const waited = now - firstSeenTerminal[d.id];
        if (waited > 120_000) stalledOver2Min.add(1);
      } else if (firstSeenTerminal[d.id]) {
        drainTime.add(now - firstSeenTerminal[d.id]);
        delete firstSeenTerminal[d.id];
      }
    }
    pendingTerminal.add(awaiting);
  }
  sleep(5);
}

export function ambientViewer(data) {
  const res = http.get(`${data.base}/duels/live`, HEADERS);
  check(res, { 'hub still answers during the burst': (r) => r.status === 200 });
  sleep(10);
}

export function teardown(data) {
  checkMoneyInvariants(data.base, { operatorToken: __ENV.OPERATOR_TOKEN });
  console.log(
    '[burst] Record: peak duels_awaiting_settlement, settlement_drain_ms p50/p99, ' +
      'and — from LOADTEST_METRICS — tick pass duration and keeper submit→confirm latency. ' +
      'ALSO record whether matchmaking still worked during the drain. It is predicted not to.',
  );
}
