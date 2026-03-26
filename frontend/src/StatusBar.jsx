/**
 * StatusBar — displays cluster state at a glance.
 * Phase 1: shows WS connection status and known leader.
 * Phase 3: will show live replica states from /status polling.
 */

export function StatusBar({ status, leader, replicaStates = [] }) {
  const dot = {
    connected: { color: "var(--follower)", label: "CONNECTED" },
    connecting: { color: "var(--leader)", label: "CONNECTING" },
    disconnected: { color: "var(--danger)", label: "DISCONNECTED" },
  }[status] ?? { color: "var(--border)", label: status.toUpperCase() };

  return (
    <div style={styles.bar}>
      {/* WS status */}
      <div style={styles.group}>
        <span style={{ ...styles.dot, background: dot.color }} />
        <span style={styles.mono}>{dot.label}</span>
      </div>

      {/* Leader */}
      <div style={styles.group}>
        <span style={styles.label}>LEADER</span>
        <span
          style={{
            ...styles.mono,
            color: leader ? "var(--leader)" : "var(--text-secondary)",
          }}
        >
          {leader ? leader.replace(/^https?:\/\//, "") : "unknown"}
        </span>
      </div>

      {/* Replica chips — populated in Phase 3 */}
      {replicaStates.map((r) => (
        <div key={r.node_id} style={styles.group}>
          <span
            style={{
              ...styles.chip,
              borderColor:
                r.role === "leader"
                  ? "var(--leader)"
                  : r.role === "candidate"
                    ? "var(--accent)"
                    : "var(--border)",
              color:
                r.role === "leader" ? "var(--leader)" : "var(--text-secondary)",
            }}
          >
            {r.node_id} · {r.role} · t{r.current_term}
          </span>
        </div>
      ))}

      <div style={{ marginLeft: "auto", ...styles.label }}>MINIRAFT v0.1</div>
    </div>
  );
}

const styles = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 20,
    padding: "0 16px",
    height: 36,
    background: "var(--bg-panel)",
    borderBottom: "1px solid var(--border)",
    flexShrink: 0,
    overflow: "hidden",
  },
  group: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  },
  mono: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    letterSpacing: "0.04em",
  },
  label: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    color: "var(--text-secondary)",
    letterSpacing: "0.08em",
  },
  chip: {
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.04em",
    padding: "2px 7px",
    border: "1px solid",
    borderRadius: "var(--radius-sm)",
  },
};
