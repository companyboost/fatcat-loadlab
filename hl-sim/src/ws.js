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

import { markPrice, PERP_ASSETS } from "./world.js";
import { buildAssetCtxs, buildFillEvent } from "./shapes.js";
import { inc } from "./metrics.js";

/** address (lowercased) -> Set<ws> */
const fillSubs = new Map();
/** Set<ws> subscribed to the global market stream */
const ctxSubs = new Set();

let markTimer = null;

export function startMarkFeed() {
  if (markTimer) return;
  // The real feed pushes continuously. One second matches what the backend
  // persists (mark_snapshots, ~1/s) without pretending to more fidelity.
  markTimer = setInterval(() => {
    if (ctxSubs.size === 0) return;
    const frame = JSON.stringify({
      channel: "activeAssetCtx",
      data: buildAssetCtxs(Date.now(), false),
    });
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
  const frame = JSON.stringify({
    channel: "userFills",
    data: buildFillEvent(address, [fill], false),
  });
  let sent = 0;
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) {
      ws.send(frame);
      sent += 1;
    }
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

    if (sub.type === "activeAssetCtx" || sub.type === "fastAssetCtxs") {
      if (subscribing) {
        ctxSubs.add(ws);
        ws.subscriptions.add("ctx");
        // Snapshot first, then deltas — the backend judges freshness by stream
        // health and refuses rows until a snapshot has landed.
        ws.send(
          JSON.stringify({ channel: "activeAssetCtx", data: buildAssetCtxs(Date.now(), true) }),
        );
      } else {
        ctxSubs.delete(ws);
      }
      ws.send(JSON.stringify({ channel: "subscriptionResponse", data: { method: msg.method, subscription: sub } }));
      return;
    }

    if (sub.type === "userFills" && sub.user) {
      const key = String(sub.user).toLowerCase();
      if (subscribing) {
        if (!fillSubs.has(key)) fillSubs.set(key, new Set());
        fillSubs.get(key).add(ws);
        ws.subscriptions.add(`fills:${key}`);
        inc("ws_unique_users_seen");
        // isSnapshot: true on the first message, matching the venue. The
        // backend distinguishes snapshot from delta to avoid double-counting.
        ws.send(JSON.stringify({ channel: "userFills", data: buildFillEvent(key, [], true) }));
      } else {
        fillSubs.get(key)?.delete(ws);
      }
      ws.send(JSON.stringify({ channel: "subscriptionResponse", data: { method: msg.method, subscription: sub } }));
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
