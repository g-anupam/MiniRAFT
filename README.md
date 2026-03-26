# MiniRAFT — Distributed Real-Time Drawing Board

A fault-tolerant collaborative whiteboard backed by a mini-RAFT consensus protocol.
Built as a 3-week project assignment.

## Architecture

```
Browser(s)
    │  WebSocket
    ▼
┌─────────┐   HTTP POST /stroke     ┌──────────┐
│ Gateway │ ─────────────────────▶  │ Replica 1│ (Leader)
│  :8080  │ ◀─────────────────────  │  :9001   │
│  (Node) │  POST /committed-stroke └──────────┘
└─────────┘                               │ AppendEntries
                                    ┌─────┴─────┐
                                    ▼           ▼
                               ┌──────────┐ ┌──────────┐
                               │ Replica 2│ │ Replica 3│
                               │  :9002   │ │  :9003   │
                               └──────────┘ └──────────┘
```

## Project Structure

```
miniraft/
├── docker-compose.yml
├── API_SPEC.md
├── gateway/
│   ├── Dockerfile
│   ├── package.json
│   └── index.js
├── replica1/           ← bind-mounted: edit → auto-reload
│   ├── Dockerfile
│   ├── requirements.txt
│   └── main.py
├── replica2/
│   └── ...             ← identical code, different env vars
├── replica3/
│   └── ...
└── frontend/
    ├── index.html
    ├── vite.config.js
    ├── package.json
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── DrawingCanvas.jsx
        ├── StatusBar.jsx
        ├── EventLog.jsx
        └── useWebSocket.js
```

## Quick Start

### 1. Start the backend cluster

```bash
docker compose up --build
```

Services:
- `gateway`  → http://localhost:8080
- `replica1` → http://localhost:9001
- `replica2` → http://localhost:9002
- `replica3` → http://localhost:9003

### 2. Start the frontend (dev)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173

### 3. Verify everything is up

```bash
# Gateway health
curl http://localhost:8080/health

# Replica statuses
curl http://localhost:9001/status
curl http://localhost:9002/status
curl http://localhost:9003/status
```

## Hot-Reload (bind mounts)

Each replica folder is bind-mounted into its container. Editing any `.py`
file triggers `uvicorn --reload` automatically — no `docker compose restart` needed.

```bash
# Example: edit replica1's code
vim replica1/main.py   # save → container reloads in ~1s
```

## Phase Roadmap

| Phase | Focus | Status |
|-------|-------|--------|
| Phase 1 | Scaffolding, skeletons, API spec | ✅ Done |
| Phase 2 | Leader election, log replication, WS pipeline | ⏳ Next |
| Phase 3 | Catch-up sync, hot-reload hardening, chaos testing | 🔜 Soon |

## RAFT Timing

| Parameter | Value |
|-----------|-------|
| Election timeout | 500–800 ms (random) |
| Heartbeat interval | 150 ms |
| Gateway leader poll | 300 ms |

## Port Reference

| Service | Internal | External |
|---------|----------|----------|
| Gateway (WS+HTTP) | 8080 | 8080 |
| Replica 1 | 9001 | 9001 |
| Replica 2 | 9002 | 9002 |
| Replica 3 | 9003 | 9003 |
| Frontend (dev) | 5173 | 5173 |
