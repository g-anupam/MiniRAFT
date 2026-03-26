# MiniRAFT — API Specification

## Replica RPC Endpoints

All replicas expose the following HTTP endpoints.
Inter-replica communication is plain JSON over HTTP on the internal Docker network.

---

### GET /status

Returns current node state. Used by the gateway for leader discovery and by the optional Phase 3 dashboard.

**Response**
```json
{
  "node_id":      "replica1",
  "role":         "follower | candidate | leader",
  "current_term": 3,
  "leader_id":    "replica2",
  "log_length":   42,
  "commit_index": 41,
  "peers":        ["http://replica2:9002", "http://replica3:9003"]
}
```

---

### POST /request-vote

**RAFT RequestVote RPC.** Sent by a Candidate to all peers during an election.

**Request**
```json
{
  "term":           4,
  "candidate_id":   "replica1",
  "last_log_index": 41,
  "last_log_term":  3
}
```

**Response**
```json
{
  "term":         4,
  "vote_granted": true
}
```

**Rules (Phase 2)**
- Grant vote if `req.term >= current_term` AND (`voted_for` is null OR equals `candidate_id`) AND candidate log is at least as up-to-date.
- Always update `current_term` to `max(current_term, req.term)`.

---

### POST /append-entries

**RAFT AppendEntries RPC.** Sent by the Leader to replicate log entries to Followers. Also used as a log-consistency probe (empty `entries` = heartbeat-with-check).

**Request**
```json
{
  "term":           4,
  "leader_id":      "replica2",
  "prev_log_index": 40,
  "prev_log_term":  3,
  "entries": [
    { "index": 41, "term": 4, "entry": { "stroke_id": "abc123", "points": [...], "color": "#3d8bff", "width": 3 } }
  ],
  "leader_commit":  40
}
```

**Response**
```json
{
  "term":        4,
  "success":     true,
  "match_index": 41
}
```

**Rules (Phase 2)**
- Reject if `req.term < current_term`.
- Reject if log at `prev_log_index` does not match `prev_log_term`.
- Append new entries; truncate any conflicting tail.
- Update `commit_index = min(leader_commit, last_new_index)`.

---

### POST /heartbeat

**RAFT Heartbeat RPC.** Sent by Leader every 150 ms to prevent Follower election timeouts.

**Request**
```json
{
  "term":      4,
  "leader_id": "replica2"
}
```

**Response**
```json
{
  "term":    4,
  "success": true
}
```

**Rules (Phase 2)**
- Reset election timeout on receipt.
- If `req.term > current_term`, step down to Follower and update term.

---

### POST /sync-log

**Catch-up RPC.** Called by the Leader on a rejoining Follower to push all missing committed entries.

**Request**
```json
{
  "from_index": 15
}
```

**Response**
```json
{
  "entries": [
    { "index": 15, "term": 2, "entry": { ... } },
    { "index": 16, "term": 2, "entry": { ... } }
  ],
  "commit_index": 41
}
```

**Rules (Phase 3)**
- Leader sends `log[from_index:]` where all entries have `index <= commit_index`.
- Follower appends all entries and sets `commit_index`.

---

### POST /stroke

**Stroke submission.** Called by the Gateway to submit a new drawing stroke to the Leader.

**Request**
```json
{
  "stroke_id": "abc123",
  "points":    [{"x": 0.1, "y": 0.2}, {"x": 0.15, "y": 0.25}],
  "color":     "#3d8bff",
  "width":     3.0
}
```

**Response (202 Accepted)**
```json
{ "status": "received", "node_id": "replica2" }
```

**Error (409 Conflict — not leader)**
```json
{ "detail": "replica1 is not the leader (role=follower)" }
```

---

## Gateway Endpoints

### GET /health

```json
{
  "status":           "ok",
  "connectedClients": 3,
  "currentLeader":    "http://replica2:9002",
  "replicas":         ["http://replica1:9001", "http://replica2:9002", "http://replica3:9003"]
}
```

### POST /committed-stroke

Called by the Leader replica once a stroke is committed by quorum. Gateway broadcasts to all WebSocket clients.

**Request** — same shape as stroke above.

---

## WebSocket Protocol (Gateway ↔ Browser)

All messages are JSON objects with a `type` field.

### Gateway → Client

| type | payload | description |
|------|---------|-------------|
| `connected` | `{ message, leader }` | Sent on WS handshake |
| `stroke` | `{ stroke }` | Committed stroke to render |
| `leader_change` | `{ leader }` | Emitted when gateway detects new leader |

### Client → Gateway

| type | payload | description |
|------|---------|-------------|
| `stroke` | `{ stroke }` | New stroke drawn by this client |

---

## RAFT Timing Constants

| Parameter | Value |
|-----------|-------|
| Election timeout | random 500–800 ms |
| Heartbeat interval | 150 ms |
| Leader discovery poll (gateway) | 300 ms |
| Gateway WS reconnect delay | 2000 ms |
| Replica HTTP call timeout | 500 ms |

---

## Failure Scenarios

| Scenario | Expected Behaviour |
|----------|--------------------|
| Leader crashes | Followers time out, election held within 800 ms, new leader elected |
| Follower crashes | Leader continues with 2-node majority, crashed node rejoins via /sync-log |
| Split vote | All candidates restart election with a new random timeout |
| Network partition (bonus) | Minority partition cannot elect a leader (no quorum); majority continues |
| Hot-reload (file edit) | Container restarts → node rejoins as Follower → catch-up via /sync-log |
| Gateway restarts | Clients reconnect automatically after 2 s; gateway rediscovers leader |
| Two simultaneous client strokes | Both routed to same leader; log ordering preserved by term+index |
