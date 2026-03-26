/**
 * useWebSocket — Phase 2
 * =======================
 * Changes from Phase 1:
 *   - sendStroke() now actually sends the stroke over WebSocket
 *   - incoming "stroke" messages call onStroke() to render on canvas
 *   - "leader_change" messages update local leader state
 *
 * Everything else (reconnect loop, message parsing, logging) is unchanged.
 */

import { useEffect, useRef, useState, useCallback } from "react";

const GATEWAY_WS_URL =
  import.meta.env.VITE_GATEWAY_WS_URL ?? "ws://localhost:8080";
const RECONNECT_DELAY_MS = 2000;

export function useWebSocket({ onStroke }) {
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  const [status, setStatus] = useState("disconnected");
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
          // Render the committed stroke on the canvas
          addLog(
            `Remote stroke | id=${msg.stroke?.stroke_id} | color=${msg.stroke?.color} | pts=${msg.stroke?.points?.length}`,
          );
          onStroke?.(msg.stroke);
          break;

        case "leader_change":
          addLog(`Leader → ${msg.leader ?? "unknown"}`);
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

    ws.onerror = () => {
      addLog("WebSocket error");
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
   * Send a completed stroke to the gateway.
   * Phase 2: actually transmits over WebSocket.
   */
  const sendStroke = useCallback(
    (stroke) => {
      addLog(
        `Stroke sent | id=${stroke.stroke_id} | color=${stroke.color} | pts=${stroke.points.length}`,
      );

      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        addLog("Cannot send — not connected");
        return;
      }

      wsRef.current.send(JSON.stringify({ type: "stroke", stroke }));
    },
    [addLog],
  );

  return { status, leader, logs, sendStroke };
}
