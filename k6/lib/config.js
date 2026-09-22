// Shared config + the production guard every scenario must pass through.
//
// Audit guardrail 6: load tests run against STAGING ONLY. There is no staging
// backend URL anywhere in this workspace, so BASE_URL is mandatory and is
// checked against a deny-list of hosts known to be production.

const PRODUCTION_HOSTS = [
  'fatcat-backend-production.up.railway.app',
  'app.fatcatarena.xyz',
  'fatcatarena.xyz',
];

export function baseUrl() {
  const url = __ENV.BASE_URL;
  if (!url) {
    throw new Error(
      'BASE_URL is required. Load tests run against staging only — see loadtest/README.md.',
    );
  }
  for (const host of PRODUCTION_HOSTS) {
    if (url.includes(host)) {
      throw new Error(
        `Refusing to run: ${host} is PRODUCTION. Audit guardrail 6 permits staging only.`,
      );
    }
  }
  return url.replace(/\/+$/, '');
}

/** A duel id to exercise. Scenario 3 and 4 need a real, live duel on staging. */
export function duelId() {
  const id = __ENV.DUEL_ID;
  if (!id) throw new Error('DUEL_ID is required for this scenario (a live duel on staging).');
  return id;
}

/** Client poll cadences, copied verbatim from the app so the model stays honest.
 *  Change these ONLY when the corresponding client constant changes. */
export const CADENCE = {
  // codebase/fatcat-app/src/lib/hooks/use-duel-api.ts:365
  duel: 4,
  // codebase/fatcat-app/src/lib/chat/polling-transport.ts:24
  chat: 3,
  // codebase/fatcat-app/src/lib/hooks/use-duel-chat.ts:20
  pulse: 5,
  // codebase/fatcat-app/src/lib/hooks/use-duel-chat.ts:21
  heartbeat: 15,
  // codebase/fatcat-app/src/lib/hooks/use-duel-api.ts:397
  live: 10,
};

/** Requests per minute one viewer generates on a duel screen, doing nothing.
 *  [DERIVED] 60/4 + 60/3 + 60/5 + 60/15 = 51 — see docs/audit/01-api-inventory.md */
export const REQUESTS_PER_VIEWER_PER_MIN = 51;

export const HEADERS = { headers: { Accept: 'application/json' } };
