// 02 — DUEL RAMP. 100 → 1,000 → 5,000 → 10,000 concurrent duels, 30 min/step.
//
// THE POINT IS TO FIND THE CEILING, NOT TO PASS.
// Record the exact step at which each subsystem breaks, and write it into
// docs/audit/03-loadtest-results.md as "at load X, the first thing that breaks
// is Y".
//
// AUDIT PREDICTION, to be confirmed or falsified:
//   - Hyperliquid weight is exceeded at FEWER THAN ONE duel
//     (2,496 weight/min/duel vs a 1,200/min per-IP budget).
//   - The hl-consumer scoring loop degrades between 20 and 50 duels
//     (pass duration ≈ duels/4 × 1.2 s vs a 5 s interval).
//   ⇒ Step 1 (100 duels) is expected to fail. That IS the result.
//
// PREREQUISITES — this scenario writes to staging and needs real fighters:
//   FIGHTER_TOKENS  newline-separated Privy tokens for provisioned, funded,
//                   FLAT staging accounts. Two per duel.
//   Backend running with LOADTEST_METRICS=1.
// Without FIGHTER_TOKENS this runs in OBSERVE-ONLY mode: it will not create
// duels, and will instead poll and report what the arena is already doing.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Gauge } from 'k6/metrics';
import { baseUrl, HEADERS } from './lib/config.js';
import { checkMoneyInvariants } from './lib/invariants.js';

export const queuePostLatency = new Trend('queue_post_latency', true);
export const liveDuels = new Gauge('live_duels_observed');
export const scoreAge = new Trend('live_score_age_ms', true);
export const rateLimited = new Counter('http_429');

const STEPS = [100, 1000, 5000, 10000];
const HOLD = __ENV.HOLD || '30m';

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: STEPS.flatMap((target) => [
        { duration: '2m', target },
        { duration: HOLD, target },
      ]).concat([{ duration: '2m', target: 0 }]),
      gracefulRampDown: '60s',
    },
  },
  thresholds: {
    // Written as the GOAL, not as an expectation. A breach here is the finding.
    'live_score_age_ms': ['p(99)<10000'],  // scoring cadence is 5s; 2x is the ceiling
    'http_429': ['count==0'],
    'money_invariant_violations': ['count==0'],
    'stalled_duels': ['count==0'],
  },
};

export function setup() {
  const base = baseUrl();
  const tokens = (__ENV.FIGHTER_TOKENS || '').split('\n').map((t) => t.trim()).filter(Boolean);
  if (tokens.length < 2) {
    console.warn(
      '[ramp] OBSERVE-ONLY: no FIGHTER_TOKENS. Duels will not be created; ' +
        'this run measures read-path behaviour and score age only.',
    );
  }
  return { base, tokens, observeOnly: tokens.length < 2 };
}

export default function (data) {
  if (!data.observeOnly) {
    // One VU = one fighter queueing. Pairing is the backend's job.
    const token = data.tokens[__VU % data.tokens.length];
    const res = http.post(
      `${data.base}/duels/queue`,
      JSON.stringify({ arena: 'perps', coin: 'BTC', durationId: '5m', stakeUsd: 1 }),
      { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } },
    );
    queuePostLatency.add(res.timings.duration);
    if (res.status === 429) rateLimited.add(1);
    // 409 duel_in_progress is EXPECTED and correct: competition_slots.user_id
    // is a primary key, so one account can hold at most one live duel.
    check(res, { 'queue accepted or already fighting': (r) => [200, 201, 409].includes(r.status) });
  }

  // Observe: how many duels are live, and how stale is the score behind them?
  // This is the measurement that finds the hl-consumer ceiling.
  const live = http.get(`${data.base}/duels/live`, HEADERS);
  if (live.status === 429) rateLimited.add(1);
  if (live.status === 200) {
    const duels = live.json('duels') || [];
    liveDuels.add(duels.length);
    const now = Date.now();
    for (const d of duels.slice(0, 5)) {
      if (d.left && d.left.scoredAt) scoreAge.add(now - d.left.scoredAt);
      if (d.right && d.right.scoredAt) scoreAge.add(now - d.right.scoredAt);
    }
  }

  sleep(10);
}

export function teardown(data) {
  checkMoneyInvariants(data.base, { operatorToken: __ENV.OPERATOR_TOKEN });
  console.log(
    '[ramp] Record, per step: live_duels_observed, live_score_age_ms p99, ' +
      'and (from LOADTEST_METRICS) HL weight consumed and tick pass duration.',
  );
}
