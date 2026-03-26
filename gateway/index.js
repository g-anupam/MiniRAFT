/**
 * MiniRAFT — Gateway Service (Phase 1 Skeleton)
 * ================================================
 * Responsibilities:
 *   - Accept WebSocket connections from browser clients
 *   - Discover the current RAFT leader by polling replicas /status
 *   - Forward strokes from clients to the leader replica
 *   - Broadcast committed strokes back to all connected clients
 *
 * Phase 1: WebSocket connections are accepted and logged.
 *           Leader discovery polls replicas but takes no action yet.
 *           Stroke forwarding is stubbed (logs payload, doesn't forward).
 *
 * Phase 2: Wire real leader forwarding + broadcast on commit callback.
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "8080");
const REPLICA_URLS = (process.env.REPLICA_URLS ?? "")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

console.log(
  `[gateway] Starting | port=${PORT} | replicas=${REPLICA_URLS.join(", ")}`,
);

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * currentLeaderUrl — the HTTP base URL of the replica we believe is leader.
 * null means unknown; gateway will discover on next poll cycle.
 */
let currentLeaderUrl = null;

/** All connected WebSocket clients */
const clients = new Set();

// ─── Express + HTTP server ────────────────────────────────────────────────────

const app = express();
app.use(express.json());

/** Health check */
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    connectedClients: clients.size,
    currentLeader: currentLeaderUrl,
    replicas: REPLICA_URLS,
  });
});

/**
 * POST /committed-stroke
 * Called by the leader replica once a stroke has been committed
 * by a majority quorum. Gateway broadcasts it to all WS clients.
 *
 * Phase 1: stub — logs receipt.
 * Phase 2: broadcast to all clients.
 */
app.post("/committed-stroke", (req, res) => {
  const stroke = req.body;
  console.log(
    `[gateway] /committed-stroke received | stroke_id=${stroke?.stroke_id}`,
  );

  // TODO Phase 2: broadcast(JSON.stringify({ type: "stroke", stroke }))
  res.json({ status: "received" });
});

const httpServer = createServer(app);

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  clients.add(ws);
  console.log(
    `[gateway] Client connected | total=${clients.size} | ip=${req.socket.remoteAddress}`,
  );

  ws.on("message", (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      console.warn("[gateway] Received non-JSON message, ignoring");
      return;
    }

    console.log(`[gateway] Message received | type=${msg.type}`);

    if (msg.type === "stroke") {
      handleIncomingStroke(msg.stroke, ws);
    } else {
      console.warn(`[gateway] Unknown message type: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[gateway] Client disconnected | total=${clients.size}`);
  });

  ws.on("error", (err) => {
    console.error(`[gateway] WebSocket error: ${err.message}`);
    clients.delete(ws);
  });

  // Send initial state to newly connected client
  ws.send(
    JSON.stringify({
      type: "connected",
      message: "Connected to MiniRAFT gateway",
      leader: currentLeaderUrl,
    }),
  );
});

// ─── Stroke handling ──────────────────────────────────────────────────────────

/**
 * Handles an incoming stroke from a client.
 * Phase 1: logs and stubs — no forwarding yet.
 * Phase 2: forwards to currentLeaderUrl/stroke via HTTP POST.
 */
function handleIncomingStroke(stroke, _senderWs) {
  console.log(
    `[gateway] Stroke | id=${stroke?.stroke_id} | color=${stroke?.color} | points=${stroke?.points?.length} | leader=${currentLeaderUrl ?? "unknown"}`,
  );

  if (!currentLeaderUrl) {
    console.warn("[gateway] No known leader — stroke dropped (Phase 1 stub)");
    // TODO Phase 2: queue stroke and retry after leader discovery
    return;
  }

  // TODO Phase 2: forward stroke to leader
  // fetch(`${currentLeaderUrl}/stroke`, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify(stroke),
  // })
  //   .then(...)
  //   .catch((err) => { ... re-discover leader ... });
}

/**
 * Broadcast a message to all connected WebSocket clients.
 * Used in Phase 2 when a committed stroke arrives from the leader.
 */
function broadcast(data) {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ─── Leader discovery ─────────────────────────────────────────────────────────

/**
 * Polls all replica /status endpoints to find the current leader.
 * Updates currentLeaderUrl if a leader is found.
 *
 * Phase 1: polling works, but finding a leader has no downstream effect yet.
 * Phase 2: on leader change, re-route stroke forwarding.
 */
async function discoverLeader() {
  for (const replicaUrl of REPLICA_URLS) {
    try {
      const res = await fetch(`${replicaUrl}/status`, {
        signal: AbortSignal.timeout(500),
      });
      if (!res.ok) continue;

      const data = await res.json();

      if (data.role === "leader") {
        if (currentLeaderUrl !== replicaUrl) {
          console.log(
            `[gateway] Leader discovered/changed: ${replicaUrl} (term=${data.current_term})`,
          );
          currentLeaderUrl = replicaUrl;
        }
        return; // found it — stop polling
      }
    } catch {
      // replica unreachable — try next
    }
  }

  // No leader found this cycle
  if (currentLeaderUrl !== null) {
    console.warn("[gateway] No leader found — clearing currentLeaderUrl");
    currentLeaderUrl = null;
  }
}

// Poll for leader every 300ms
setInterval(discoverLeader, 300);
discoverLeader(); // run immediately on boot

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[gateway] HTTP + WebSocket server listening on port ${PORT}`);
});
