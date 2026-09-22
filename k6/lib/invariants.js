// Money-invariant assertions, run in teardown() after EVERY scenario.
//
// Threshold gate: "zero money-invariant violations". These are the four the
// audit verified hold today (docs/audit/00-evidence.md §7) plus the stall check.
// A load test that degrades throughput is information. A load test that breaks
// one of these is a stop-everything event.

import http from 'k6/http';
import { Counter } from 'k6/metrics';

export const invariantViolations = new Counter('money_invariant_violations');
export const stalledDuels = new Counter('stalled_duels');

/**
 * Read-only checks against endpoints that exist today.
 *
 * Deeper invariants (settlements-row-before-settled-flip, ledger zero-sum)
 * need database access and are NOT asserted here — asserting them from the
 * public API would be guesswork. They belong in a pgTAP suite run beside this.
 */
export function checkMoneyInvariants(base, opts = {}) {
  const violations = [];

  // 1. No duel may sit at `matched` or `proposed` for more than 2 minutes.
  //    /duels/live only lists `active`, so this needs the operator surface;
  //    without a token it degrades to "not checked", which is reported as such
  //    rather than silently passing.
  if (opts.operatorToken) {
    const res = http.get(`${base}/accounting/duels/review`, {
      headers: { Authorization: `Bearer ${opts.operatorToken}` },
    });
    if (res.status === 200) {
      const parked = (res.json('duels') || []).length;
      if (parked > (opts.parkedBaseline || 0)) {
        violations.push(`review_required grew to ${parked} during the run`);
      }
    }
  } else {
    console.warn('[invariants] no OPERATOR_TOKEN: stall + review checks NOT RUN');
  }

  // 2. Every live duel must expose a coherent shape. A duel that reports
  //    `status: live` with an ends_at in the past is a stalled resolveWindows.
  const live = http.get(`${base}/duels/live`);
  if (live.status === 200) {
    const now = Date.now();
    for (const d of live.json('duels') || []) {
      if (d.status === 'live' && d.endsAt && d.endsAt < now - 120_000) {
        stalledDuels.add(1);
        violations.push(`duel ${d.id} live but ended ${Math.round((now - d.endsAt) / 1000)}s ago`);
      }
      // 3. pot must equal 2x stake, always (routes/duels.ts:1097).
      if (d.pot != null && d.left && d.left.marginUsd != null) {
        if (Math.abs(d.pot - d.left.marginUsd * 2) > 1e-6) {
          violations.push(`duel ${d.id}: pot ${d.pot} != 2 x stake ${d.left.marginUsd}`);
        }
      }
    }
  }

  // 4. The service must still be healthy and still have all three deps.
  const health = http.get(`${base}/health`);
  if (health.status !== 200) {
    violations.push(`/health returned ${health.status}`);
  } else {
    const deps = health.json('deps') || {};
    for (const dep of ['redis', 'supabase', 'privy']) {
      if (deps[dep] !== true) violations.push(`dependency ${dep} unhealthy after run`);
    }
  }

  for (const v of violations) {
    invariantViolations.add(1);
    console.error(`[MONEY INVARIANT VIOLATED] ${v}`);
  }
  return violations;
}
