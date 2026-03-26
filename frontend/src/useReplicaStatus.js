/**
 * useReplicaStatus — Phase 3
 * ===========================
 * Polls all replica /status endpoints every second and returns their
 * live state. Used by StatusBar to show the cluster health dashboard.
 *
 * Returns an array of status objects (one per reachable replica):
 *   [{ node_id, role, current_term, leader_id, log_length, commit_index }]
 *
 * Unreachable replicas are shown with role "unreachable".
 */

import { useEffect, useState } from "react";

const REPLICA_URLS = [
  import.meta.env.VITE_REPLICA1_URL ?? "http://localhost:9001",
  import.meta.env.VITE_REPLICA2_URL ?? "http://localhost:9002",
  import.meta.env.VITE_REPLICA3_URL ?? "http://localhost:9003",
];

const POLL_INTERVAL_MS = 1000;

export function useReplicaStatus() {
  const [replicaStates, setReplicaStates] = useState([]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      const results = await Promise.all(
        REPLICA_URLS.map(async (url) => {
          try {
            const res = await fetch(`${url}/status`, {
              signal: AbortSignal.timeout(800),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
          } catch {
            // Replica unreachable — return a placeholder so UI shows it as down
            const id = url.split(":").pop(); // "9001" → use as fallback id
            return {
              node_id: `replica-${id}`,
              role: "unreachable",
              current_term: null,
              leader_id: null,
              log_length: null,
              commit_index: null,
            };
          }
        }),
      );

      if (!cancelled) setReplicaStates(results);
    }

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return replicaStates;
}
