/**
 * MiniRAFT — Gateway Service (Phase 2 — Fully Wired)
 * ====================================================
 * Phase 2 additions over Phase 1:
 *   - handleIncomingStroke() actually POSTs to the leader
 *   - On 409 (not leader) or network error → re-discover leader and retry once
 *   - POST /committed-stroke → broadcasts the stroke to all WS clients
 *   - Stroke queue: strokes arriving during leader election are buffered
 *     and flushed once a new leader is found
 *
 * Endpoints:
 *   GET  /health              → gateway status
 *   POST /committed-stroke    → called by leader replica after commit
 *
 * WebSocket messages:
 *   client → gateway  { type: "stroke", stroke: {...} }
 *   gateway → client  { type: "connected", leader }
 *   gateway → client  { type: "stroke", stroke: {...} }
 *   gateway → client  { type: "leader_change", leader }
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

console.log(`[gateway] Starting | port=${PORT} | replicas=${REPLICA_URLS.join(", ")}`);

// ─── State ───────────────────────────────────────────────────────────────────

let currentLeaderUrl = null;

/** Strokes queued while there is no known leader (during election) */
const strokeQueue = [];
const MAX_QUEUE   = 50;   // safety cap — drop oldest if queue overflows

/** All connected WebSocket clients */
const clients = new Set();

/**
 * In-memory cache of every committed stroke, in order.
 * Sent to newly connecting clients so they see the full canvas immediately.
 * Cleared if the gateway restarts (acceptable — replicas still hold the log).
 */
const committedLog = [];

// ─── Express ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status:           "ok",
    connectedClients: clients.size,
    currentLeader:    currentLeaderUrl,
    queuedStrokes:    strokeQueue.length,
    replicas:         REPLICA_URLS,
  });
});

/**
 * POST /committed-stroke
 * Called by the leader once a stroke is committed by majority quorum.
 * Broadcasts it to every connected WebSocket client.
 */
app.post("/committed-stroke", (req, res) => {
  const stroke = req.body;

  if (stroke?.type === "clear") {
    // Wipe the log — new tabs joining after a clear should start blank,
    // not replay everything before the clear
    committedLog.length = 0;
    console.log(`[gateway] Clear event committed — log wiped | broadcasting to ${clients.size} client(s)`);
  } else {
    committedLog.push(stroke);
    console.log(
      `[gateway] Committed stroke received | stroke_id=${stroke?.stroke_id} | log_size=${committedLog.length} | broadcasting to ${clients.size} client(s)`
    );
  }

  broadcast({ type: "stroke", stroke });
  res.json({ status: "ok" });
});

const httpServer = createServer(app);

// ─── WebSocket ────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  clients.add(ws);
  console.log(
    `[gateway] Client connected | total=${clients.size} | ip=${req.socket.remoteAddress}`
  );

  // 1. Send handshake
  ws.send(
    JSON.stringify({
      type:    "connected",
      message: "Connected to MiniRAFT gateway",
      leader:  currentLeaderUrl,
    })
  );

  // 2. Replay the full committed stroke log so the canvas is up to date
  if (committedLog.length > 0) {
    console.log(`[gateway] Replaying ${committedLog.length} stroke(s) to new client`);
    ws.send(JSON.stringify({ type: "replay", strokes: committedLog }));
  }

  ws.on("message", (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch {
      console.warn("[gateway] Non-JSON message ignored");
      return;
    }

    if (msg.type === "stroke") {
      handleIncomingStroke(msg.stroke);
    } else {
      console.warn(`[gateway] Unknown message type: ${msg.type}`);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[gateway] Client disconnected | total=${clients.size}`);
  });

  ws.on("error", (err) => {
    console.error(`[gateway] WS error: ${err.message}`);
    clients.delete(ws);
  });
});

// ─── Stroke handling ──────────────────────────────────────────────────────────

/**
 * Forward a stroke from a client to the current leader.
 * If no leader is known → queue the stroke.
 * If the leader rejects (409) or is unreachable → re-discover and retry once.
 */
async function handleIncomingStroke(stroke) {
  if (!currentLeaderUrl) {
    console.warn(
      `[gateway] No leader — queuing stroke | stroke_id=${stroke?.stroke_id} | queue_size=${strokeQueue.length + 1}`
    );
    enqueue(stroke);
    return;
  }

  const success = await forwardStroke(stroke, currentLeaderUrl);

  if (!success) {
    // Leader may have changed — re-discover and retry once
    console.warn("[gateway] Forward failed — re-discovering leader and retrying");
    await discoverLeader();

    if (currentLeaderUrl) {
      await forwardStroke(stroke, currentLeaderUrl);
    } else {
      console.warn("[gateway] Still no leader after retry — queuing stroke");
      enqueue(stroke);
    }
  }
}

/**
 * POST the stroke to a specific replica URL.
 * Returns true on success, false on any error or non-2xx response.
 */
async function forwardStroke(stroke, leaderUrl) {
  try {
    const res = await fetch(`${leaderUrl}/stroke`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(stroke),
      signal:  AbortSignal.timeout(1000),
    });

    if (res.ok) {
      console.log(
        `[gateway] Stroke forwarded | stroke_id=${stroke?.stroke_id} | leader=${leaderUrl}`
      );
      return true;
    }

    if (res.status === 409) {
      console.warn(
        `[gateway] 409 from ${leaderUrl} — not the leader anymore`
      );
      currentLeaderUrl = null;
      return false;
    }

    console.warn(`[gateway] Unexpected ${res.status} from ${leaderUrl}`);
    return false;

  } catch (err) {
    console.error(`[gateway] forwardStroke error: ${err.message}`);
    currentLeaderUrl = null;
    return false;
  }
}

function enqueue(stroke) {
  if (strokeQueue.length >= MAX_QUEUE) {
    const dropped = strokeQueue.shift();
    console.warn(`[gateway] Queue full — dropped oldest stroke | stroke_id=${dropped?.stroke_id}`);
  }
  strokeQueue.push(stroke);
}

async function flushQueue() {
  if (!strokeQueue.length || !currentLeaderUrl) return;
  console.log(
    `[gateway] Flushing ${strokeQueue.length} queued stroke(s) → ${currentLeaderUrl}`
  );
  const toFlush = strokeQueue.splice(0);
  for (const stroke of toFlush) {
    await forwardStroke(stroke, currentLeaderUrl);
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// ─── Leader discovery ─────────────────────────────────────────────────────────

/**
 * Poll all replicas for /status and find who is leader.
 * Updates currentLeaderUrl and notifies clients on change.
 * Also flushes the stroke queue when a new leader is found.
 */
async function discoverLeader() {
  let found = null;

  for (const replicaUrl of REPLICA_URLS) {
    try {
      const res = await fetch(`${replicaUrl}/status`, {
        signal: AbortSignal.timeout(500),
      });
      if (!res.ok) continue;

      const data = await res.json();

      if (data.role === "leader") {
        found = replicaUrl;
        break;
      }
    } catch {
      // replica unreachable — try next
    }
  }

  if (found && found !== currentLeaderUrl) {
    console.log(
      `[gateway] Leader ${currentLeaderUrl ? "changed" : "discovered"}: ${found}`
    );
    currentLeaderUrl = found;
    broadcast({ type: "leader_change", leader: found });
    await flushQueue();
  } else if (!found && currentLeaderUrl !== null) {
    console.warn("[gateway] No leader found — election in progress");
    currentLeaderUrl = null;
  }
}

setInterval(discoverLeader, 300);
discoverLeader();

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`[gateway] Listening on port ${PORT}`);
});
