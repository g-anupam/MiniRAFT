/**
 * EventLog — scrollable log panel showing WS + stroke events.
 * Phase 1: shows all console-level events from useWebSocket.
 * Phase 3: will also show RAFT election/commit events from replicas.
 */

import { useEffect, useRef } from "react";

export function EventLog({ logs = [] }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>EVENT LOG</span>
        <span style={styles.count}>{logs.length} entries</span>
      </div>
      <div style={styles.scroll}>
        {logs.length === 0 && (
          <div style={styles.empty}>Waiting for events…</div>
        )}
        {logs.map((line, i) => (
          <div key={i} style={styles.line}>
            <span style={styles.lineText}>{line}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

const styles = {
  panel: {
    display: "flex",
    flexDirection: "column",
    width: 300,
    flexShrink: 0,
    borderLeft: "1px solid var(--border)",
    background: "var(--bg-panel)",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "8px 12px",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
  },
  title: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.08em",
    color: "var(--text-secondary)",
  },
  count: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    color: "var(--border)",
  },
  scroll: {
    flex: 1,
    overflowY: "auto",
    padding: "8px 0",
  },
  empty: {
    padding: "12px",
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--border)",
    textAlign: "center",
  },
  line: {
    padding: "2px 12px",
  },
  lineText: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    lineHeight: 1.6,
  },
};
