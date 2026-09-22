// The simulated venue's state.
//
// Design note, because it is the whole point of this file: the simulator must be
// O(1) in the number of fighters it can *answer about*, not O(fighters) in memory
// or work. A 10,000-duel run means 20,000 distinct addresses, each polled every
// five seconds. Materialising 20,000 account objects and mutating them on a timer
// would make the simulator the bottleneck we are trying to measure around.
//
// So account state is DERIVED, not stored: an address plus the current time is
// enough to compute a deterministic, plausible, self-consistent account. Only
// addresses that actually trade get a stored override.

import { createHash } from "node:crypto";

/** Deterministic 0..1 from an address and a salt. Same address always yields the
 *  same "personality", so a duel's score is reproducible across a restart. */
function hashUnit(address, salt) {
  const h = createHash("sha256").update(`${address}:${salt}`).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

/** Assets the simulated venue lists. Keep this small: every extra perp costs a
 *  row in metaAndAssetCtxs, which the scorer parses on every pass. */
export const PERP_ASSETS = ["BTC", "ETH", "SOL", "HYPE", "PEPE"];

/**
 * Spot pairs. Hyperliquid addresses these as `@<index>`, and the backend
 * requires `universe.name === "@" + universe.index`, so the index is the
 * identity here — not the array position.
 */
export const SPOT_ASSETS = [
  { index: 50, price: 1.0 },
  { index: 476, price: 2.5 },
  { index: 1035, price: 0.75 },
  { index: 1137, price: 12.0 },
  { index: 1165, price: 0.031 },
  { index: 1253, price: 105.0 },
];

const BASE_PRICE = { BTC: 64000, ETH: 3200, SOL: 150, HYPE: 22, PEPE: 0.0000091 };

/**
 * Mark price at a point in time. A slow deterministic sine plus a fast jitter,
 * so PnL moves realistically and both fighters see the SAME mark — which is what
 * makes a simulated duel's outcome meaningful rather than noise.
 */
export function markPrice(coin, nowMs = Date.now()) {
  const base = BASE_PRICE[coin] ?? 100;
  const slow = Math.sin(nowMs / 600_000) * 0.02; // ±2% over ~10 min
  const fast = Math.sin(nowMs / 7_000) * 0.002; // ±0.2% chop
  return base * (1 + slow + fast);
}

/** Hyperliquid returns numbers as STRINGS almost everywhere. Getting this wrong
 *  is the classic silent-mis-scoring bug, so every emitted number goes through
 *  one of these two helpers rather than being interpolated ad hoc. */
export function px(n) {
  return String(Number(n).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""));
}
export function usd(n) {
  return String(Number(n).toFixed(6));
}

/**
 * A fighter's simulated position. Derived from the address so it is stable, and
 * from the clock so it moves. `openedAt` is quantised to the hour so a duel that
 * spans a restart keeps a coherent entry price.
 */
export function derivePosition(address, nowMs) {
  const pick = hashUnit(address, "coin");
  const coin = PERP_ASSETS[Math.floor(pick * PERP_ASSETS.length)];
  const side = hashUnit(address, "side") > 0.5 ? 1 : -1;
  const leverage = 2 + Math.floor(hashUnit(address, "lev") * 8); // 2x..10x
  const sizeUsd = 50 + hashUnit(address, "size") * 450; // $50..$500

  const openedAt = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const entryPx = markPrice(coin, openedAt);
  const nowPx = markPrice(coin, nowMs);

  const szi = (sizeUsd / entryPx) * side;
  const unrealized = (nowPx - entryPx) * szi;

  return { coin, side, leverage, sizeUsd, entryPx, nowPx, szi, unrealized, openedAt };
}

/**
 * Explicit overrides, for scripted scenarios: a fighter who must win, a fighter
 * who must be knocked out, an account that must look flat. Small and bounded —
 * only addresses a scenario deliberately touches land here.
 */
const overrides = new Map();

export function setOverride(address, patch) {
  overrides.set(address.toLowerCase(), { ...(overrides.get(address.toLowerCase()) ?? {}), ...patch });
}
export function getOverride(address) {
  return overrides.get(address.toLowerCase());
}
export function clearOverrides() {
  overrides.clear();
}

/** Simulated equity for an address. `startingEquity` is deterministic so ROI is
 *  reproducible; a flat account (no position) is the default for anyone the
 *  scenario has not deliberately put into a trade. */
export function deriveAccount(address, nowMs) {
  const o = getOverride(address);
  if (o?.flat) {
    const eq = o.equity ?? 1000;
    return { equity: eq, startingEquity: eq, positions: [], flat: true };
  }
  const startingEquity = o?.startingEquity ?? 500 + Math.floor(hashUnit(address, "eq") * 4500);
  if (o?.noPosition) return { equity: startingEquity, startingEquity, positions: [], flat: true };

  const pos = derivePosition(address, nowMs);
  const equity = startingEquity + pos.unrealized + (o?.pnlNudge ?? 0);
  return { equity, startingEquity, positions: [pos], flat: false };
}
