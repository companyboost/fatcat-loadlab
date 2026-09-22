// Hyperliquid simulator — staging only.
//
// Purpose: remove Hyperliquid's external rate-limit ceiling (1,200 request-weight
// per minute per IP, and 10 unique users across user-specific WebSocket
// subscriptions) so the system's OWN limits can be measured. It is not a
// faithful exchange and must never be treated as one.
//
// It answers the `info` POST endpoint and serves the two WebSocket topics the
// backend subscribes to.

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { handleInfo } from "./info.js";
import { startMarkFeed, attachSocket } from "./ws.js";
import { counters, inc, snapshot } from "./metrics.js";

const PORT = Number(process.env.PORT ?? 8080);

// ---------------------------------------------------------------------------
// Refuse to run anywhere but staging.
//
// This simulator returns fabricated fills and account equity. If it were ever
// reachable by a production backend, it would feed invented numbers into a
// money path. The guard is deliberately loud and fails closed.
// ---------------------------------------------------------------------------
function assertStagingOnly() {
  const env = process.env.APP_ENV;
  if (env !== "staging") {
    console.error(
      `[hl-sim] REFUSING TO START: APP_ENV is ${env ?? "unset"}, expected "staging".\n` +
        `[hl-sim] This process fabricates account state and fills. It must never be\n` +
        `[hl-sim] reachable from a production backend.`,
    );
    process.exit(1);
  }
  if (process.env.HL_ENV === "mainnet" || process.env.MAINNET_MONEY_ENABLED === "true") {
    console.error("[hl-sim] REFUSING TO START: mainnet indicators present in the environment.");
    process.exit(1);
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      // A real info request is tiny. Anything large is a bug or an attack.
      if (size > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true, service: "hl-sim", uptimeSec: Math.floor(process.uptime()) });
  }

  // Own metrics, so a run can prove the backend talked to the SIMULATOR and not
  // to the real venue — and can attribute weight per request type.
  if (req.method === "GET" && url.pathname === "/sim/metrics") {
    return json(res, 200, snapshot());
  }

  // Scenario control: scripted overrides (force a win, a KO, a flat account).
  if (req.method === "POST" && url.pathname === "/sim/override") {
    try {
      const body = await readBody(req);
      const { setOverride, clearOverrides } = await import("./world.js");
      if (body.clear) {
        clearOverrides();
        return json(res, 200, { ok: true, cleared: true });
      }
      if (!body.address) return json(res, 400, { error: "address required" });
      setOverride(body.address, body.patch ?? {});
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 400, { error: "bad request" });
    }
  }

  if (req.method === "POST" && url.pathname === "/info") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: "bad json" });
    }

    inc("info_requests_total");
    inc(`info_requests_total{type=${body?.type ?? "unknown"}}`);

    // Fault injection, so 06-hl-degraded can actually create the fault it has
    // never been able to create. Off unless a scenario turns it on.
    const fault = process.env.SIM_FAULT;
    if (fault === "429") {
      inc("info_429_total");
      res.writeHead(429, { "retry-after": "5", "content-type": "application/json" });
      return res.end('{"error":"rate limited"}');
    }
    if (fault === "timeout") {
      inc("info_timeout_total");
      return; // hold the socket open; the backend's own deadline must fire
    }
    if (fault === "500") {
      inc("info_500_total");
      return json(res, 500, { error: "simulated upstream failure" });
    }

    try {
      const out = handleInfo(body);
      if (out === undefined) {
        inc(`info_unhandled_total{type=${body?.type ?? "unknown"}}`);
        console.warn(`[hl-sim] UNHANDLED info type: ${body?.type}`);
        // Loud, not silent: an unhandled type returning {} is exactly how a
        // simulator produces a confident wrong measurement.
        return json(res, 501, { error: `unhandled info type: ${body?.type}` });
      }
      return json(res, 200, out);
    } catch (err) {
      console.error("[hl-sim] handler threw:", err);
      return json(res, 500, { error: "simulator error" });
    }
  }

  json(res, 404, { error: "not found" });
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", attachSocket);

assertStagingOnly();
startMarkFeed();

server.listen(PORT, () => {
  console.log(`[hl-sim] listening on :${PORT} (APP_ENV=staging)`);
  console.log(`[hl-sim]   POST /info         info endpoint`);
  console.log(`[hl-sim]   WS   /ws           fastAssetCtxs, userFills`);
  console.log(`[hl-sim]   GET  /sim/metrics  request counters`);
  console.log(`[hl-sim]   POST /sim/override scenario control`);
  if (process.env.SIM_FAULT) console.log(`[hl-sim]   FAULT INJECTION ACTIVE: ${process.env.SIM_FAULT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[hl-sim] ${sig} — draining`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

export { server, counters };
