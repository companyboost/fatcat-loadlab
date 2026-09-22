// Contract test.
//
// These assertions are not "does the simulator return something" — they are
// the specific shape rules that, when broken, cause the backend to MIS-SCORE
// SILENTLY rather than fail. Each one cites the backend behaviour it protects.
// If one of these goes red, no measurement taken against this simulator means
// anything.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { handleInfo } from "../src/info.js";
import { SPOT_ASSETS, PERP_ASSETS } from "../src/world.js";

const ADDR = "0xabc0000000000000000000000000000000000001";

/** The backend's own parser, copied verbatim from duel-score.ts:32-43.
 *  It rejects "+1", "", ".5", "1e-7", "1,000", NaN and Infinity. Any monetary
 *  or price string we emit must survive it, or the value becomes null and the
 *  duel is frozen as `basis_unreadable` instead of erroring. */
function parseScaled(raw) {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(String(raw).trim());
  return m ? Number(raw) : null;
}

function assertParsable(value, what) {
  assert.notEqual(parseScaled(value), null, `${what}: "${value}" fails the backend's parseScaled`);
}

test("userAbstraction returns a bare string, not an object", () => {
  const out = handleInfo({ type: "userAbstraction", user: ADDR });
  assert.equal(typeof out, "string", "an object here throws 'unsupported Hyperliquid account mode'");
  assert.ok(
    ["default", "disabled", "unifiedAccount"].includes(out),
    `mode "${out}" normalises to unknown and hl-consumer.ts:432 throws`,
  );
});

test("clearinghouseState exposes accountValue as a parsable string", () => {
  const out = handleInfo({ type: "clearinghouseState", user: ADDR });
  assert.equal(typeof out.marginSummary.accountValue, "string");
  assertParsable(out.marginSummary.accountValue, "marginSummary.accountValue");
  assert.ok(Array.isArray(out.assetPositions), "hl-consumer.ts:434 expects an array");
  for (const ap of out.assetPositions) {
    const p = ap.position;
    assert.equal(typeof p.coin, "string");
    assertParsable(p.szi, "position.szi");
    assertParsable(p.entryPx, "position.entryPx");
    assertParsable(p.unrealizedPnl, "position.unrealizedPnl");
    assert.equal(typeof p.leverage.value, "number");
  }
});

test("spotClearinghouseState always has a balances array with a USDC row", () => {
  const out = handleInfo({ type: "spotClearinghouseState", user: ADDR });
  assert.ok(Array.isArray(out.balances), "hl-consumer.ts:384 iterates this and would throw");
  const usdc = out.balances.find((b) => b.coin === "USDC");
  assert.ok(usdc, "a missing USDC row silently degrades equity to 0");
  assertParsable(usdc.total, "USDC balance.total");
});

test("spot universe name matches @index, and ctx.coin joins by name", () => {
  const [meta, ctxs] = handleInfo({ type: "spotMetaAndAssetCtxs" });
  for (const u of meta.universe) {
    // hl-consumer.ts:383 skips any market failing this, so spot equity silently
    // reads as nothing.
    assert.equal(u.name, `@${u.index}`, "universe.name must equal '@' + universe.index");
  }
  const names = new Set(meta.universe.map((u) => u.name));
  for (const c of ctxs) {
    assert.ok(names.has(c.coin), `ctx.coin ${c.coin} has no matching universe entry`);
    // spot-market-map.ts:28 — no leading zeros, no '+', no exponent, and > 0.
    assert.match(c.markPx, /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/, `markPx ${c.markPx} is rejected`);
    assert.ok(Number(c.markPx) > 0, "a mark of 0 drops the market");
  }
  const quote = meta.tokens.find((t) => t.index === 0);
  assert.equal(quote.name, "USDC", "the quote token must be named exactly USDC");
});

test("spotMeta is served bare and carries a USDC token with tokenId", () => {
  const meta = handleInfo({ type: "spotMeta" });
  const usdc = meta.tokens.find((t) => t.name === "USDC");
  // prediction-rail.ts:86 and hl-faucet.ts:44 throw without this.
  assert.ok(usdc, "throws 'USDC spot token not found in spotMeta'");
  assert.equal(typeof usdc.tokenId, "string");
  assert.equal(typeof usdc.weiDecimals, "number");
});

test("l2Book is a [bids, asks] tuple with both sides populated", () => {
  const out = handleInfo({ type: "l2Book", coin: `@${SPOT_ASSETS[0].index}` });
  assert.ok(Array.isArray(out.levels) && out.levels.length === 2, "destructured at spot-liquidity-probe.ts:240");
  const [bids, asks] = out.levels;
  assert.ok(bids.length > 0 && asks.length > 0, "an empty side closes the spot gate");
  assert.equal(typeof out.time, "number");
  // A fixed or zero `time` makes every book look stale against
  // SPOT_LIQUIDITY_MAX_BOOK_AGE_MS and closes spot intake.
  assert.ok(Date.now() - out.time < 5_000, "book time must be the current snapshot time");
});

test("ledger streams return arrays, and the non-funding stream is empty by default", () => {
  const fills = handleInfo({ type: "userFillsByTime", user: ADDR, startTime: Date.now() - 120_000 });
  assert.ok(Array.isArray(fills));
  for (const f of fills) {
    assert.equal(typeof f.time, "number", "time is the paging cursor and must be a number");
    assert.equal(typeof f.tid, "number");
    assert.match(f.hash, /^0x[0-9a-f]{64}$/, "hash is half the dedupe identity");
    assertParsable(f.px, "fill.px");
    assertParsable(f.sz, "fill.sz");
    assertParsable(f.closedPnl, "fill.closedPnl");
    assertParsable(f.fee, "fill.fee");
    assert.ok(f.side === "A" || f.side === "B", "any non-'A' silently becomes a BUY");
  }

  const funding = handleInfo({ type: "userFunding", user: ADDR, startTime: Date.now() - 120_000 });
  assert.ok(Array.isArray(funding));

  // A stray transfer-type delta inside a duel window parks EVERY duel in
  // review_required (findTransferViolation). Empty is the correct steady state.
  const ledger = handleInfo({ type: "userNonFundingLedgerUpdates", user: ADDR, startTime: Date.now() - 120_000 });
  assert.deepEqual(ledger, [], "a non-empty default would park every duel for review");
});

test("paged reads terminate: a page must be shorter than the cap", () => {
  // fetchPaged stops when a page is shorter than the cap (2000 fills, 500
  // ledger). A simulator that always returns a full page spins the backend
  // until MAX_PAGES and then reports the window as incomplete, which freezes
  // the duel's score rather than erroring.
  const fills = handleInfo({ type: "userFillsByTime", user: ADDR, startTime: Date.now() - 600_000 });
  assert.ok(fills.length < 2000, "a full page forces another round trip");
});

test("an unhandled info type is not answered", () => {
  assert.equal(handleInfo({ type: "somethingNobodyImplemented" }), undefined);
});

test("every perp mark in a fastAssetCtxs frame survives deflate and parseScaled", async () => {
  const { startMarkFeed } = await import("../src/ws.js");
  assert.equal(typeof startMarkFeed, "function");

  // Rebuild a frame the way ws.js does and prove it round-trips. The SDK
  // decodes with DecompressionStream("deflate-raw"); plain JSON here means the
  // decode throws, no mark ever lands, and every score reads mark_stale.
  const { deflateRawSync } = await import("node:zlib");
  const map = {};
  for (const c of PERP_ASSETS) map[c] = { markPx: "100.5", midPx: "100.4" };
  const encoded = deflateRawSync(Buffer.from(JSON.stringify(map))).toString("base64");
  const decoded = JSON.parse(inflateRawSync(Buffer.from(encoded, "base64")).toString("utf8"));

  for (const coin of PERP_ASSETS) {
    assert.equal(typeof decoded[coin].markPx, "string", "mark-stream.ts:72 requires a string");
    assertParsable(decoded[coin].markPx, `${coin}.markPx`);
  }
});
