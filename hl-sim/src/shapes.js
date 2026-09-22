// Response shapes.
//
// ⚠️ THE RISK THIS FILE CARRIES
// Hyperliquid returns most numbers as STRINGS. A field emitted as a number, or
// omitted, does not make the backend throw — it makes the scorer compute a
// wrong answer and record it as verified. That is the single most dangerous
// failure mode of a simulator, because every downstream measurement then looks
// healthy and is wrong.
//
// Therefore: nothing here is trusted until `npm test` in this package passes
// the contract test, which asserts these shapes against the field accesses in
// `fatcat-backend`. Until that test is green, treat any run against this
// simulator as UNVALIDATED. See docs/RUNBOOK.md step 4.

import { deriveAccount, markPrice, px, usd, PERP_ASSETS } from "./world.js";

/** perps `clearinghouseState` */
export function buildClearinghouseState(address, nowMs) {
  const acct = deriveAccount(address, nowMs);
  const assetPositions = acct.positions.map((p) => ({
    type: "oneWay",
    position: {
      coin: p.coin,
      szi: px(p.szi),
      leverage: { type: "cross", value: p.leverage },
      entryPx: px(p.entryPx),
      positionValue: usd(Math.abs(p.szi) * p.nowPx),
      unrealizedPnl: usd(p.unrealized),
      returnOnEquity: usd(p.unrealized / Math.max(1, acct.startingEquity)),
      liquidationPx: px(p.entryPx * (p.side > 0 ? 0.5 : 1.5)),
      marginUsed: usd(p.sizeUsd / p.leverage),
      maxLeverage: 20,
      cumFunding: { allTime: usd(0), sinceOpen: usd(0), sinceChange: usd(0) },
    },
  }));

  return {
    marginSummary: {
      accountValue: usd(acct.equity),
      totalNtlPos: usd(acct.positions.reduce((s, p) => s + Math.abs(p.szi) * p.nowPx, 0)),
      totalRawUsd: usd(acct.equity),
      totalMarginUsed: usd(acct.positions.reduce((s, p) => s + p.sizeUsd / p.leverage, 0)),
    },
    crossMarginSummary: {
      accountValue: usd(acct.equity),
      totalNtlPos: usd(acct.positions.reduce((s, p) => s + Math.abs(p.szi) * p.nowPx, 0)),
      totalRawUsd: usd(acct.equity),
      totalMarginUsed: usd(acct.positions.reduce((s, p) => s + p.sizeUsd / p.leverage, 0)),
    },
    crossMaintenanceMarginUsed: usd(0),
    withdrawable: usd(Math.max(0, acct.equity * 0.5)),
    assetPositions,
    time: nowMs,
  };
}

/** `spotClearinghouseState` */
export function buildSpotClearinghouseState(address, nowMs) {
  const acct = deriveAccount(address, nowMs);
  return {
    balances: [
      {
        coin: "USDC",
        token: 0,
        hold: usd(0),
        total: usd(Math.max(0, acct.equity * 0.1)),
        entryNtl: usd(0),
      },
    ],
  };
}

/** `userAbstraction` — the account-mode read. */
export function buildUserAbstraction(address) {
  return { type: "unabstracted", address };
}

/** A synthetic fill. `tid` and `hash` must be stable per fill: the backend
 *  dedupes on `hl_fill_hash`, so an unstable hash would insert duplicates and
 *  inflate every fill-count measurement. */
export function buildFill(address, seq, nowMs) {
  const coin = PERP_ASSETS[seq % PERP_ASSETS.length];
  const price = markPrice(coin, nowMs);
  const size = 0.01 + (seq % 7) * 0.003;
  const side = seq % 2 === 0 ? "B" : "A";
  return {
    coin,
    px: px(price),
    sz: px(size),
    side,
    time: nowMs,
    startPosition: px(0),
    dir: side === "B" ? "Open Long" : "Close Long",
    closedPnl: usd(0),
    hash: `0x${Buffer.from(`${address}:${seq}`).toString("hex").slice(0, 64).padEnd(64, "0")}`,
    oid: 1_000_000 + seq,
    crossed: true,
    fee: usd(size * price * 0.00035),
    tid: Number(`${seq}${String(nowMs).slice(-6)}`),
    feeToken: "USDC",
    builderFee: usd(size * price * 0.0001),
  };
}

/** `userFillsByTime` */
export function buildUserFillsByTime(address, startTime, endTime) {
  // Deliberately bounded and deterministic. `fetchPaged` in the backend keeps
  // requesting while a full page comes back, so a simulator that always
  // returned a full page would spin the backend forever. Returning a short
  // page is what TERMINATES the loop.
  const window = Math.max(0, (endTime ?? Date.now()) - startTime);
  const count = Math.min(3, Math.floor(window / 60_000));
  return Array.from({ length: count }, (_, i) =>
    buildFill(address, i, startTime + i * 20_000),
  );
}

/** `userFunding` */
export function buildUserFunding(address, startTime) {
  return [
    {
      time: startTime + 1_000,
      hash: `0x${"f".repeat(64)}`,
      delta: {
        type: "funding",
        coin: "BTC",
        usdc: usd(-0.0012),
        szi: px(0.01),
        fundingRate: usd(0.0000125),
      },
    },
  ];
}

/** `userNonFundingLedgerUpdates` */
export function buildUserNonFundingLedger(address, startTime) {
  // Empty is the common and important case: the backend must treat an empty
  // window as COVERED, not as a gap. A simulator that never returns empty
  // would hide exactly that bug.
  return [];
}

/** `metaAndAssetCtxs` */
export function buildMetaAndAssetCtxs(nowMs) {
  const universe = PERP_ASSETS.map((name) => ({
    name,
    szDecimals: 5,
    maxLeverage: 20,
    onlyIsolated: false,
  }));
  const ctxs = PERP_ASSETS.map((coin) => {
    const mark = markPrice(coin, nowMs);
    return {
      funding: usd(0.0000125),
      openInterest: usd(1_000_000),
      prevDayPx: px(mark * 0.99),
      dayNtlVlm: usd(50_000_000),
      premium: usd(0.0001),
      oraclePx: px(mark),
      markPx: px(mark),
      midPx: px(mark),
      impactPxs: [px(mark * 0.9995), px(mark * 1.0005)],
      dayBaseVlm: usd(1_000),
    };
  });
  return [{ universe }, ctxs];
}

/** WebSocket `activeAssetCtx` / `fastAssetCtxs` frame payload. */
export function buildAssetCtxs(nowMs, isSnapshot) {
  return {
    isSnapshot: Boolean(isSnapshot),
    time: nowMs,
    ctxs: PERP_ASSETS.map((coin) => ({ coin, markPx: px(markPrice(coin, nowMs)), midPx: px(markPrice(coin, nowMs)) })),
  };
}

/** WebSocket `userFills` frame payload. */
export function buildFillEvent(address, fills, isSnapshot) {
  return { isSnapshot: Boolean(isSnapshot), user: address, fills };
}

/** `spotMetaAndAssetCtxs` */
export function buildSpotMetaAndAssetCtxs(nowMs, spotAssets) {
  const tokens = [{ name: "USDC", szDecimals: 8, weiDecimals: 8, index: 0, isCanonical: true }];
  const universe = spotAssets.map((name, i) => ({
    name,
    tokens: [i + 1, 0],
    index: i,
    isCanonical: false,
  }));
  const ctxs = spotAssets.map((coin, i) => ({
    coin,
    markPx: px(1 + i),
    midPx: px(1 + i),
    prevDayPx: px(1 + i),
    dayNtlVlm: usd(100_000),
    circulatingSupply: usd(1_000_000),
  }));
  return [{ tokens, universe }, ctxs];
}

/** `l2Book` — a deliberately tight, tradeable book so the spot-liquidity gate opens. */
export function buildL2Book(coin, nowMs) {
  const mid = coin.startsWith("@") ? 1 + Number(coin.slice(1)) % 5 : markPrice(coin, nowMs);
  const level = (p, n) => ({ px: px(p), sz: px(n), n: 1 });
  return {
    coin,
    time: nowMs,
    levels: [
      [level(mid * 0.9995, 1000), level(mid * 0.999, 2000), level(mid * 0.998, 4000)],
      [level(mid * 1.0005, 1000), level(mid * 1.001, 2000), level(mid * 1.002, 4000)],
    ],
  };
}

/** `allMids` */
export function buildAllMids(nowMs) {
  const mids = {};
  for (const coin of PERP_ASSETS) mids[coin] = px(markPrice(coin, nowMs));
  return mids;
}

/** `userRateLimit` — always generous; the point of the simulator is no ceiling. */
export function buildUserRateLimit() {
  return { cumVlm: usd(10_000_000), nRequestsUsed: 0, nRequestsCap: 10_000_000 };
}

/** `candleSnapshot` */
export function buildCandleSnapshot(coin, interval, startTime, endTime) {
  const step = 60_000;
  const out = [];
  for (let t = startTime; t < (endTime ?? Date.now()) && out.length < 500; t += step) {
    const o = markPrice(coin, t);
    const c = markPrice(coin, t + step);
    out.push({
      t,
      T: t + step - 1,
      s: coin,
      i: interval,
      o: px(o),
      c: px(c),
      h: px(Math.max(o, c) * 1.0005),
      l: px(Math.min(o, c) * 0.9995),
      v: px(100),
      n: 42,
    });
  }
  return out;
}
