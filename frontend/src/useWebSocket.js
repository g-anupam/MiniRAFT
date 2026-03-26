/**
 * useWebSocket — Phase 1 Skeleton
 * ================================
 * Manages the WebSocket connection to the gateway.
 * - Connects on mount, reconnects on close/error
 * - Parses incoming messages and dispatches them
 * - Exposes sendStroke() for the canvas to call
 *
 * Phase 1: connection + logging only, sendStroke logs to console.
 * Phase 2: sendStroke actually sends; incoming "stroke" messages render on canvas.
 */

import { useEffect, useRef, useState, useCallback } from "react";

const GATEWAY_WS_URL =
  import.meta.env.VITE_GATEWAY_WS_URL ?? "ws://localhost:8080";
const RECONNECT_DELAY_MS = 2000;

export function useWebSocket({ onStroke }) {
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  const [status, setStatus] = useState("disconnected"); // "disconnected" | "connecting" | "connected"
  const [leader, setLeader] = useState(null);
  const [logs, setLogs] = useState([]);

  const addLog = useCallback((msg) => {
    const ts = new Date().toLocaleTimeString("en", { hour12: false });
    setLogs((prev) => [...prev.slice(-99), `${ts}  ${msg}`]);
    console.log(`[ws] ${msg}`);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus("connecting");
    addLog("Connecting to gateway...");

    const ws = new WebSocket(GATEWAY_WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      addLog("Connected to gateway");
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        addLog(`Non-JSON message: ${event.data}`);
        return;
      }

      switch (msg.type) {
        case "connected":
          addLog(`Gateway handshake OK | leader=${msg.leader ?? "unknown"}`);
          setLeader(msg.leader);
          break;

        case "stroke":
          // TODO Phase 2: call onStroke(msg.stroke) to render on canvas
          addLog(
            `Stroke received | id=${msg.stroke?.stroke_id} | color=${msg.stroke?.color} | pts=${msg.stroke?.points?.length}`,
          );
          onStroke?.(msg.stroke);
          break;

        case "leader_change":
          addLog(`Leader changed → ${msg.leader}`);
          setLeader(msg.leader);
          break;

        default:
          addLog(`Unknown message type: ${msg.type}`);
      }
    };

    ws.onclose = (event) => {
      setStatus("disconnected");
      addLog(
        `Disconnected (code=${event.code}) — reconnecting in ${RECONNECT_DELAY_MS}ms`,
      );
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = (err) => {
      addLog(`WebSocket error: ${err.message ?? "unknown"}`);
    };
  }, [addLog, onStroke]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  /**
   * Serialize and send a completed stroke to the gateway.
   * Phase 1: logs to console only.
   * Phase 2: actually sends via WebSocket.
   */
  const sendStroke = useCallback(
    (stroke) => {
      addLog(
        `Stroke drawn | id=${stroke.stroke_id} | color=${stroke.color} | pts=${stroke.points.length}`,
      );

      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        addLog("Cannot send — not connected");
        return;
      }

      // TODO Phase 2: uncomment to actually send
      // wsRef.current.send(JSON.stringify({ type: "stroke", stroke }));
    },
    [addLog],
  );

  return { status, leader, logs, sendStroke };
}
