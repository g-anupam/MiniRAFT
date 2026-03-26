/**
 * StatusBar — Phase 3
 * ====================
 * Shows:
 *   - WebSocket connection status dot
 *   - Known gateway leader
 *   - Live replica chips (role, term, log length) polled every second
 *
 * Replica chip colours:
 *   amber  = leader
 *   teal   = follower
 *   blue   = candidate
 *   red    = unreachable
 */

export function StatusBar({ status, leader, replicaStates = [] }) {
  const wsIndicator = {
    connected: { color: "var(--follower)", label: "CONNECTED" },
    connecting: { color: "var(--leader)", label: "CONNECTING" },
    disconnected: { color: "var(--danger)", label: "DISCONNECTED" },
  }[status] ?? { color: "var(--border)", label: status.toUpperCase() };

  return (
    <div style={styles.bar}>
      {/* WS status */}
      <div style={styles.group}>
        <span style={{ ...styles.dot, background: wsIndicator.color }} />
        <span style={styles.mono}>{wsIndicator.label}</span>
      </div>

      <div style={styles.divider} />

      {/* Gateway leader */}
      <div style={styles.group}>
        <span style={styles.label}>LEADER</span>
        <span
          style={{
            ...styles.mono,
            color: leader ? "var(--leader)" : "var(--text-secondary)",
          }}
        >
          {leader
            ? leader.replace(/^https?:\/\/[^:]+:/, ":") // show just ":9001"
            : "—"}
        </span>
      </div>

      <div style={styles.divider} />

      {/* Live replica chips */}
      {replicaStates.length === 0 && (
        <span style={{ ...styles.label, opacity: 0.5 }}>polling replicas…</span>
      )}

      {replicaStates.map((r) => (
        <ReplicaChip key={r.node_id} replica={r} />
      ))}

      {/* Version tag pushed to the right */}
      <div style={{ marginLeft: "auto" }}>
        <span style={styles.label}>MINIRAFT v0.1</span>
      </div>
    </div>
  );
}

function ReplicaChip({ replica }) {
  const { node_id, role, current_term, log_length, commit_index } = replica;

  const roleStyle = {
    leader: { border: "var(--leader)", color: "var(--leader)" },
    follower: { border: "var(--follower)", color: "var(--text-secondary)" },
    candidate: { border: "var(--accent)", color: "var(--accent)" },
    unreachable: { border: "var(--danger)", color: "var(--danger)" },
  }[role] ?? { border: "var(--border)", color: "var(--text-secondary)" };

  // Short label: "replica1" → "r1"
  const shortId = node_id.replace("replica", "r");

  const termLabel = current_term != null ? `t${current_term}` : "—";
  const logLabel = log_length != null ? `l${log_length}` : "";
  const commitLabel = commit_index != null ? `c${commit_index}` : "";

  const detail =
    role === "unreachable"
      ? "down"
      : [termLabel, logLabel, commitLabel].filter(Boolean).join(" ");

  return (
    <div
      style={{
        ...styles.chip,
        borderColor: roleStyle.border,
        color: roleStyle.color,
      }}
    >
      <span style={{ fontWeight: 500 }}>{shortId}</span>
      <span style={styles.chipRole}>
        {role === "unreachable" ? "✕" : role[0].toUpperCase()}
      </span>
      <span style={styles.chipDetail}>{detail}</span>
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
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
  divider: {
    width: 1,
    height: 16,
    background: "var(--border)",
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
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    letterSpacing: "0.04em",
    padding: "2px 8px",
    border: "1px solid",
    borderRadius: "var(--radius-sm)",
    transition: "border-color 0.3s, color 0.3s",
    whiteSpace: "nowrap",
  },
  chipRole: {
    fontSize: 9,
    opacity: 0.7,
  },
  chipDetail: {
    opacity: 0.6,
    fontSize: 9,
  },
};
