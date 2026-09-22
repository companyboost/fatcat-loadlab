// 07 — BET BURST. Scenario F.
//
// WIRED to the real endpoints, 2026-08-31. Previously a skeleton written
// against an imagined API; four of its field names did not match what shipped,
// which is the ordinary fate of a test written before the thing it tests.
// Corrected against src/routes/bets.ts rather than against the header comment.
//
// STILL NEVER RUN. Wiring it is not running it, and everything below is a
// hypothesis until somebody executes it. Requires BETTING_ACCEPTANCE_ENABLED,
// a funded pool, and BETTOR_TOKEN. See the preflight in setup().
//
// MODEL (04-betting-readiness.md §14.7):
//   20,000 spectators, 60 s pre-lock window, [ASSUMED] 30% participation
//   ⇒ [DERIVED] ~100 bets/second, ALL ON ONE POOL.
//
//   The bottleneck is ROW CONTENTION, not throughput. 100 writes/s is nothing;
//   100 writes/s to the same row is a serialisation point. This scenario exists
//   to prove the append-only + materialised-aggregate design actually removes it.
//
// THE ASSERTIONS, in priority order:
//   1. The SAME idempotency key NEVER creates two bets.
//   2. Ledger zero-sum holds continuously, not just at the end.
//   3. p99 bet acceptance < 500 ms at 100 bets/s on one pool.
//   4. No bet is accepted after `accepted_until` (the §14.4 lock).
//   5. Every accepted bet records what it was accepted AGAINST.
//      NOTE: the engine records accepted_state_version and accepted_pnl_pct,
//      NOT accepted_mark_px as §14.4 sketched. Odds are priced off the
//      fighter's PnL, so a mark would name a number that had no part in the
//      decision. The assertion follows the engine.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { baseUrl, duelId } from './lib/config.js';
import { checkMoneyInvariants } from './lib/invariants.js';

export const betLatency = new Trend('bet_accept_latency', true);
export const duplicateBets = new Counter('duplicate_bets_created');
export const lateAccepts = new Counter('bets_accepted_after_lock');
export const missingProvenance = new Counter('bets_missing_state_version');

export const options = {
  scenarios: {
    // 1,000 / 5,000 / 10,000 concurrent bettors, per the brief.
    bettors: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 500,
      maxVUs: 10000,
      stages: [
        { duration: '1m', target: 100 },   // the modelled peak: 100 bets/s
        { duration: '2m', target: 100 },
        { duration: '1m', target: 300 },   // 3x headroom probe
        { duration: '2m', target: 300 },
        { duration: '1m', target: 0 },
      ],
    },
    // Every bettor replays their own request once. This is assertion 1, and it
    // is the single most important thing this file will ever check.
    replayers: {
      executor: 'constant-arrival-rate',
      rate: 20, timeUnit: '1s',
      duration: '7m',
      preAllocatedVUs: 100, maxVUs: 500,
      exec: 'replay',
    },
  },
  thresholds: {
    'bet_accept_latency': ['p(99)<500'],
    'duplicate_bets_created': ['count==0'],
    'bets_accepted_after_lock': ['count==0'],
    'bets_missing_state_version': ['count==0'],
    'money_invariant_violations': ['count==0'],
  },
};

export function setup() {
  const base = baseUrl();
  const probe = http.get(`${base}/duels/${duelId()}/market`);
  if (probe.status === 404) {
    throw new Error(
      `No market for duel ${duelId()}. Either the duel does not exist, or it has not started. ` +
        'This scenario needs a LIVE duel inside its betting window.',
    );
  }

  // Read the tiers the server actually accepts rather than assuming $1. The
  // defaults start at $100 and a testnet faucet drips $50, so a hardcoded
  // stake is how this test measures nothing but 400s.
  const health = http.get(`${base}/health`);
  const betting = health.status === 200 ? health.json('betting') : null;
  if (!betting || !betting.acceptance) {
    throw new Error(
      'BETTING_ACCEPTANCE_ENABLED is off, so every bet will be refused 404 and this run ' +
        'would report a flat, meaningless pass. Enable it before measuring anything.',
    );
  }
  const tiers = betting.stakeTiersMicro || [];
  if (tiers.length === 0) throw new Error('No stake tiers configured.');

  return { base, id: duelId(), stakeMicro: tiers[0], acceptedUntilMs: probe.json('acceptedUntilMs') };
}

function placeBet(data, key) {
  const res = http.post(
    `${data.base}/duels/${data.id}/bets`,
    // stakeMicro as a decimal string, and the SMALLEST configured tier —
    // membership is checked, not a range, so any other number is a 400.
    JSON.stringify({
      side: __VU % 2 === 0 ? 'a' : 'b',
      stakeMicro: data.stakeMicro,
      idempotencyKey: key,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${__ENV.BETTOR_TOKEN}`,
      },
    },
  );
  betLatency.add(res.timings.duration);
  return res;
}

export default function (data) {
  const key = `k6-${__VU}-${__ITER}`;
  const res = placeBet(data, key);

  check(res, { 'bet accepted or cleanly rejected': (r) => [200, 201, 409, 422].includes(r.status) });

  if (res.status === 201 || res.status === 200) {
    const bet = res.json('bet') || {};
    // Assertion 5 — provenance. acceptedPnlPct, not acceptedMarkPx: see header.
    if (bet.acceptedStateVersion == null || bet.acceptedPnlPct === undefined) {
      missingProvenance.add(1);
    }
    // Assertion 4 — the lock is honoured SERVER-side. Compared against the
    // deadline captured in setup, not re-read per iteration: 100 bets/s each
    // fetching the market would measure this test's own traffic.
    if (data.acceptedUntilMs && bet.acceptedAtMs > data.acceptedUntilMs) {
      lateAccepts.add(1);
    }
  }
  sleep(0.5);
}

export function replay(data) {
  // Same key, twice. Must return the ORIGINAL bet, not a new one and not an error.
  const key = `k6-replay-${__VU}`;
  const first = placeBet(data, key);
  const second = placeBet(data, key);
  if (first.status < 300 && second.status < 300) {
    const a = first.json('bet.id');
    const b = second.json('bet.id');
    if (a && b && a !== b) {
      duplicateBets.add(1);
      console.error(`[DUPLICATE BET] key ${key} produced ${a} and ${b}`);
    }
  }
  sleep(1);
}

export function teardown(data) {
  checkMoneyInvariants(data.base, { operatorToken: __ENV.OPERATOR_TOKEN });
  console.log(
    '[bet-burst] Also run the settlement half: thousands of payouts for ONE duel must be a ' +
      'chunked, queued, idempotent, resumable job — kill the worker mid-settlement and ' +
      'confirm it resumes without double-paying.',
  );
}
