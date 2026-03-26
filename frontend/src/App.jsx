/**
 * App — MiniRAFT Distributed Drawing Board
 * ==========================================
 * Layout:
 *   ┌────────────────────────────────────────┐
 *   │  StatusBar (WS status, leader, replicas)│
 *   ├──────────────────────────┬─────────────┤
 *   │                          │             │
 *   │     DrawingCanvas        │  EventLog   │
 *   │                          │             │
 *   └──────────────────────────┴─────────────┘
 *
 * Phase 1: canvas captures strokes + logs them, WS connects to gateway.
 * Phase 2: strokes sent over WS, remote strokes rendered on canvas.
 * Phase 3: replica states shown in status bar.
 */

import { useState, useCallback } from "react";
import { DrawingCanvas } from "./DrawingCanvas.jsx";
import { StatusBar } from "./StatusBar.jsx";
import { EventLog } from "./EventLog.jsx";
import { useWebSocket } from "./useWebSocket.js";

export default function App() {
  // Strokes received from other clients (Phase 2: populated via WS)
  const [remoteStrokes, setRemoteStrokes] = useState([]);

  // Replica cluster states (Phase 3: populated via polling /status)
  const [replicaStates] = useState([]);

  // Called when gateway broadcasts a committed stroke from another client
  const handleRemoteStroke = useCallback((stroke) => {
    setRemoteStrokes((prev) => [...prev, stroke]);
  }, []);

  const { status, leader, logs, sendStroke } = useWebSocket({
    onStroke: handleRemoteStroke,
  });

  return (
    <div style={styles.root}>
      <StatusBar
        status={status}
        leader={leader}
        replicaStates={replicaStates}
      />

      <div style={styles.body}>
        <DrawingCanvas
          onStrokeComplete={sendStroke}
          externalStrokes={remoteStrokes}
        />
        <EventLog logs={logs} />
      </div>
    </div>
  );
}

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: "100%",
    overflow: "hidden",
  },
  body: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
};
