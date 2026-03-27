/**
 * useWebSocket — Bugfix update
 * =============================
 * Fixes:
 *   1. connect() no longer depends on onStroke — uses a stable ref instead,
 *      which stops the WebSocket from tearing down and recreating on every render.
 *   2. Handles new "replay" message type — fires onReplay(strokes) to paint
 *      the full existing canvas when a new tab connects.
 */

import { useEffect, useRef, useState, useCallback } from "react";

const GATEWAY_WS_URL =
  import.meta.env.VITE_GATEWAY_WS_URL ?? "ws://localhost:8080";
const RECONNECT_DELAY_MS = 2000;

export function useWebSocket({ onStroke, onReplay }) {
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  // Stable refs so connect() never needs them as dependencies
  const onStrokeRef = useRef(onStroke);
  const onReplayRef = useRef(onReplay);
  useEffect(() => {
    onStrokeRef.current = onStroke;
  }, [onStroke]);
  useEffect(() => {
    onReplayRef.current = onReplay;
  }, [onReplay]);

  const [status, setStatus] = useState("disconnected");
  const [leader, setLeader] = useState(null);
  const [logs, setLogs] = useState([]);

  const addLog = useCallback((msg) => {
    const ts = new Date().toLocaleTimeString("en", { hour12: false });
    setLogs((prev) => [...prev.slice(-99), `${ts}  ${msg}`]);
    console.log(`[ws] ${msg}`);
  }, []);

  // connect has NO dependency on onStroke/onReplay — uses refs instead.
  // This means the WebSocket is created exactly once and never torn down
  // due to a prop change.
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

        case "replay":
          // Full canvas history sent on connect — paint all strokes at once
          addLog(`Replaying ${msg.strokes?.length ?? 0} existing stroke(s)`);
          onReplayRef.current?.(msg.strokes ?? []);
          break;

        case "stroke":
          // Live committed stroke from another client
          addLog(
            `Remote stroke | id=${msg.stroke?.stroke_id} | color=${msg.stroke?.color} | pts=${msg.stroke?.points?.length}`,
          );
          onStrokeRef.current?.(msg.stroke);
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
  }, [addLog]); // ← addLog only — no onStroke, no onReplay

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

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
