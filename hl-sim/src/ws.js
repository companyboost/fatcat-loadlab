// WebSocket side of the simulator: the two topics the backend subscribes to.
//
//   fastAssetCtxs  — one global market-data stream (mark-stream.ts)
//   userFills      — per-address fill stream (fill-stream.ts)
//
// Why this exists at all: the real venue caps user-specific subscriptions at
// TEN UNIQUE USERS per IP. Two fighters per duel means five concurrent duels,
// which is a hard external ceiling no amount of our own engineering moves. The
// simulator has no such cap, which is the only way to observe what the
// backend's own fan-out costs.
//
// NOTE the simulator imposes no unique-user limit ON PURPOSE. That is a
// deliberate divergence from the real venue, and it means a green run here says
// nothing about the real 10-user cap. Recorded here so nobody later reads a
// passing test as evidence the cap was solved.

import { deflateRawSync } from "node:zlib";
import { markPrice, PERP_ASSETS, SPOT_ASSETS, px } from "./world.js";
import { buildFillEvent } from "./shapes.js";
import { inc } from "./metrics.js";

/**
 * ⚠️ `fastAssetCtxs` frames are NOT plain JSON.
 *
 * The SDK decodes `data` with `DecompressionStream("deflate-raw")`, so the
 * wire value is base64(raw-DEFLATE(JSON)). Sending plain JSON here means the
 * decode throws, no mark ever lands, `mark-stream` never goes live, and every
 * score comes back `mark_stale` — with nothing in the logs pointing here.
 *
 * The decompressed payload is a flat map, not an array:
 *   { "<coin>": { "markPx": "<decimal string>", "midPx": "<string|null>" } }
 * Only `markPx` is read, and only when it is a string.
 */
function encodeCtxFrame(ctxMap) {
  const raw = Buffer.from(JSON.stringify(ctxMap), "utf8");
  return JSON.stringify({ channel: "fastAssetCtxs", data: deflateRawSync(raw).toString("base64") });
}

function buildCtxMap(nowMs) {
  const out = {};
  for (const coin of PERP_ASSETS) {
    out[coin] = { markPx: px(markPrice(coin, nowMs)), midPx: px(markPrice(coin, nowMs)) };
  }
  for (const a of SPOT_ASSETS) {
    out[`@${a.index}`] = { markPx: px(a.price), midPx: px(a.price) };
  }
  return out;
}

/** address (lowercased) -> Set<ws> */
const fillSubs = new Map();
/** Set<ws> subscribed to the global market stream */
const ctxSubs = new Set();

let markTimer = null;

export function startMarkFeed() {
  if (markTimer) return;
  // The real feed pushes continuously. One second matches what the backend
  // persists (mark_snapshots, ~1/s) without pretending to more fidelity.
  // `MARK_MAX_AGE_MS` is 3,000 and freshness is judged on the time of the LAST
  // message on the stream, not per asset. So this must tick well inside 3s even
  // when nothing moved, or every score goes `mark_stale`.
  markTimer = setInterval(() => {
    if (ctxSubs.size === 0) return;
    const frame = encodeCtxFrame(buildCtxMap(Date.now()));
    // One serialised frame handed to every subscriber — the same O(streams)
    // discipline the backend's own hubs use. Serialising per socket here would
    // make the simulator the bottleneck at 10k.
    for (const ws of ctxSubs) {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    }
    inc("ws_ctx_frames_total");
  }, 1_000);
  markTimer.unref?.();
}

/** Push a fill to whoever is watching that address. Called by scenario control
 *  and by the synthetic trade generator. */
export function pushFill(address, fill) {
  const subs = fillSubs.get(address.toLowerCase());
  if (!subs || subs.size === 0) return 0;
  let sent = 0;
  for (const ws of subs) {
    if (ws.readyState !== ws.OPEN) continue;
    // Echo `user` exactly as that socket subscribed with — see the note in the
    // subscribe handler. Serialised per socket rather than once, because the
    // address string is part of the payload; the subscriber count per address
    // is tiny (one worker), so this is not the O(viewers) trap.
    ws.send(JSON.stringify({ channel: "userFills", data: buildFillEvent(ws.userAddr ?? address, [fill], false) }));
    sent += 1;
  }
  inc("ws_fill_frames_total", sent);
  return sent;
}

export function attachSocket(ws) {
  inc("ws_connections_total");
  ws.subscriptions = new Set();

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // The SDK's keepalive. Answering it matters: an unanswered ping makes the
    // transport reconnect on a timer, which looks like upstream instability and
    // would be misread as a finding.
    if (msg.method === "ping") {
      ws.send(JSON.stringify({ channel: "pong" }));
      return;
    }

    if (msg.method !== "subscribe" && msg.method !== "unsubscribe") return;
    const sub = msg.subscription ?? {};
    const subscribing = msg.method === "subscribe";

    if (sub.type === "fastAssetCtxs") {
      // The ack must come FIRST and must echo the subscription, or the SDK's
      // pending request never resolves and `subscribe failed` fires after its
      // 10s timeout. Matching is by subset, so extra fields are harmless.
      ws.send(
        JSON.stringify({
          channel: "subscriptionResponse",
          data: { method: msg.method, subscription: sub },
        }),
      );
      if (subscribing) {
        ctxSubs.add(ws);
        ws.subscriptions.add("ctx");
        // There is NO isSnapshot flag on this channel. The contract is
        // positional: the first message after every (re)subscribe is a FULL
        // map, and later messages may carry only changed coins. `mark-stream`
        // clears its entire map on that first message, so sending a partial
        // delta first permanently loses every coin it omits.
        ws.send(encodeCtxFrame(buildCtxMap(Date.now())));
      } else {
        ctxSubs.delete(ws);
      }
      return;
    }

    if (sub.type === "userFills" && sub.user) {
      // ⚠️ The SDK filters incoming events with `event.user === payload.user`,
      // an EXACT string comparison — the case-insensitive hex matching applies
      // only to the subscriptionResponse echo. Our backend subscribes with an
      // already-lowercased address, so every frame must echo `user` back
      // byte-identical or the events are silently dropped. Key on the address
      // exactly as sent, not on a re-normalised copy.
      const asSent = String(sub.user);
      const key = asSent.toLowerCase();
      ws.send(
        JSON.stringify({
          channel: "subscriptionResponse",
          data: { method: msg.method, subscription: sub },
        }),
      );
      if (subscribing) {
        if (!fillSubs.has(key)) fillSubs.set(key, new Set());
        fillSubs.get(key).add(ws);
        ws.userAddr = asSent;
        ws.subscriptions.add(`fills:${key}`);
        inc("ws_unique_users_seen");
        // isSnapshot is informational to the backend — it does not branch on
        // it and relies on `address:hash:tid` for idempotence instead.
        ws.send(JSON.stringify({ channel: "userFills", data: buildFillEvent(asSent, [], true) }));
      } else {
        fillSubs.get(key)?.delete(ws);
      }
      return;
    }

    inc(`ws_unhandled_sub_total{type=${sub.type ?? "unknown"}}`);
    console.warn(`[hl-sim] unhandled subscription: ${sub.type}`);
  });

  ws.on("close", () => {
    ctxSubs.delete(ws);
    for (const subs of fillSubs.values()) subs.delete(ws);
  });

  ws.on("error", () => {
    ctxSubs.delete(ws);
    for (const subs of fillSubs.values()) subs.delete(ws);
  });
}

export function subscriberCounts() {
  let fillSockets = 0;
  for (const s of fillSubs.values()) fillSockets += s.size;
  return { ctxSubs: ctxSubs.size, fillAddresses: fillSubs.size, fillSockets };
}

export { PERP_ASSETS, markPrice };
