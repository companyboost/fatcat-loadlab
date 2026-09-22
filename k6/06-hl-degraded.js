// 06 — HYPERLIQUID DEGRADED. 429s / timeouts for 5 minutes.
//
// TWO ASSERTIONS, and they are the most important in this directory:
//
//   1. NO DUEL SETTLES INCORRECTLY.
//   2. NO DUEL SILENTLY STALLS.
//
// The audit's reading of the code says assertion 1 holds and assertion 2 holds
// with a caveat (docs/audit/00-evidence.md #12, 02-bottlenecks.md §13):
//   - live scores FREEZE and /duels/:id keeps serving the last VERIFIED score;
//   - at timer-zero the duel parks in `review_required` (fail-closed, correct);
//   - deposits wait, then void-refund via the Draw path.
// The caveat: the freeze is INDISTINGUISHABLE FROM A HEALTHY FEED at the API,
// and there is no 429 handling or circuit breaker on this path at all
// (retryRead exists at external-read.ts:42 but is not imported by hl-consumer).
//
// ── HOW TO INJECT THE FAULT ───────────────────────────────────────────────────
// This script CANNOT create the fault; it observes it. Choose one, and record
// which you used:
//   (a) Point staging's HL transport at a local toxiproxy/WireMock returning
//       429 with Retry-After, then timing out. Cleanest.
//   (b) Add an env-gated fault injector to the transport (LOADTEST_HL_FAULT=429)
//       behind LOADTEST_METRICS=1. Changes no business behaviour.
//   (c) Firewall the egress to the HL host for 5 minutes. Blunt; also breaks
//       the browser-side chart path, which muddies the result.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Gauge, Trend } from 'k6/metrics';
import { baseUrl, HEADERS } from './lib/config.js';
import { checkMoneyInvariants } from './lib/invariants.js';

export const frozenScores = new Gauge('frozen_score_count');
export const maxScoreAge = new Trend('max_score_age_ms', true);
export const silentStalls = new Counter('silent_stalls');
export const incorrectSettlements = new Counter('incorrect_settlements');

export const options = {
  scenarios: {
    observer: { executor: 'constant-vus', vus: 1, duration: '20m', exec: 'observe' },
  },
  thresholds: {
    'incorrect_settlements': ['count==0'],   // assertion 1 — non-negotiable
    'silent_stalls': ['count==0'],           // assertion 2
    'money_invariant_violations': ['count==0'],
  },
};

// A duel whose score has not advanced for longer than this, while it is still
// being served as `live` with no review state, is a SILENT stall: the user sees
// a healthy card and a number that is not moving, and nothing says why.
const SILENT_STALL_MS = 60_000;

const lastScoredAt = {};
const lastChangeAt = {};

export function setup() {
  console.log('[hl-degraded] Inject the HL fault NOW, for 5 minutes. See header.');
  return { base: baseUrl() };
}

export function observe(data) {
  const live = http.get(`${data.base}/duels/live`, HEADERS);
  check(live, { 'hub answers while HL is degraded': (r) => r.status === 200 });
  if (live.status !== 200) { sleep(5); return; }

  const now = Date.now();
  let frozen = 0;

  for (const d of live.json('duels') || []) {
    for (const side of ['left', 'right']) {
      const f = d[side];
      if (!f || f.scoredAt == null) continue;
      const key = `${d.id}:${side}`;

      if (lastScoredAt[key] !== f.scoredAt) {
        lastScoredAt[key] = f.scoredAt;
        lastChangeAt[key] = now;
      }
      const age = now - (lastChangeAt[key] || now);
      maxScoreAge.add(age);
      if (age > 10_000) frozen += 1;

      // The key check: frozen, still presented as live, and NOT flagged.
      // `review` is populated by reviewFields() only for review_required rows
      // (routes/duels.ts:1121-1140), so its absence means the user is being
      // shown a healthy card over a dead feed.
      if (age > SILENT_STALL_MS && d.status === 'live' && !d.review) {
        silentStalls.add(1);
        console.error(
          `[SILENT STALL] duel ${d.id} ${side}: score unchanged for ${Math.round(age / 1000)}s, ` +
            'still served as live with no review state',
        );
      }

      // Assertion 1: a settled duel must never carry an unverified score.
      // scoreVerified is false only when scoring_version >= 2 and the snapshot
      // was never enriched (routes/duels.ts:1073).
      if (d.status === 'settled' && f.scoreVerified === false) {
        incorrectSettlements.add(1);
        console.error(`[INCORRECT SETTLEMENT] duel ${d.id} settled with an unverified ${side} score`);
      }
    }
  }
  frozenScores.add(frozen);
  sleep(5);
}

export function teardown(data) {
  checkMoneyInvariants(data.base, { operatorToken: __ENV.OPERATOR_TOKEN });
  console.log(
    '[hl-degraded] Expected result: scores freeze, duels park in review_required, ' +
      'NOTHING settles wrong. If silent_stalls > 0, the FREEZE IS INVISIBLE TO USERS — ' +
      'that is a product finding, not an infrastructure one.',
  );
}
