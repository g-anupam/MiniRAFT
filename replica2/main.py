"""
MiniRAFT - Replica Node (Phase 1 Skeleton)
==========================================
This file stubs all RAFT RPC endpoints and state management.
No election or replication logic yet — that comes in Phase 2.

Endpoints exposed:
  GET  /status           → current node state (for debugging & gateway discovery)
  POST /request-vote     → RAFT RequestVote RPC
  POST /append-entries   → RAFT AppendEntries RPC
  POST /heartbeat        → RAFT Heartbeat RPC
  POST /sync-log         → Catch-up sync for rejoining nodes
  POST /stroke           → Receive a stroke from the gateway (leader only)
"""

import logging
import os
from enum import Enum
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ─── Logging ────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("replica")

# ─── Config from environment ─────────────────────────────────────────────────

REPLICA_ID: str = os.getenv("REPLICA_ID", "replica-unknown")
PORT: int = int(os.getenv("PORT", "9001"))
PEERS: List[str] = [p for p in os.getenv("PEERS", "").split(",") if p]
GATEWAY_URL: str = os.getenv("GATEWAY_URL", "http://gateway:8080")

# ─── RAFT State ──────────────────────────────────────────────────────────────


class NodeState(str, Enum):
    FOLLOWER = "follower"
    CANDIDATE = "candidate"
    LEADER = "leader"


# Node state — will be mutated by RAFT logic in Phase 2
state = {
    "node_id": REPLICA_ID,
    "role": NodeState.FOLLOWER,  # always start as follower
    "current_term": 0,
    "voted_for": None,  # who we voted for in current term
    "leader_id": None,  # known leader (None if unknown)
    "log": [],  # list of {"index": int, "term": int, "entry": dict}
    "commit_index": -1,  # highest log index known to be committed
    "peers": PEERS,
}

log.info(
    "Replica %s booting | role=%s | term=%d | peers=%s",
    REPLICA_ID,
    state["role"],
    state["current_term"],
    PEERS,
)

# ─── Pydantic schemas ─────────────────────────────────────────────────────────


class VoteRequest(BaseModel):
    term: int
    candidate_id: str
    last_log_index: int
    last_log_term: int


class VoteResponse(BaseModel):
    term: int
    vote_granted: bool


class LogEntry(BaseModel):
    index: int
    term: int
    entry: dict  # will contain stroke data in Phase 2


class AppendEntriesRequest(BaseModel):
    term: int
    leader_id: str
    prev_log_index: int
    prev_log_term: int
    entries: List[LogEntry]
    leader_commit: int


class AppendEntriesResponse(BaseModel):
    term: int
    success: bool
    match_index: Optional[int] = None


class HeartbeatRequest(BaseModel):
    term: int
    leader_id: str


class HeartbeatResponse(BaseModel):
    term: int
    success: bool


class SyncLogRequest(BaseModel):
    from_index: int  # send all committed entries from this index onward


class SyncLogResponse(BaseModel):
    entries: List[LogEntry]
    commit_index: int


class StrokePayload(BaseModel):
    stroke_id: str
    points: list  # list of {x, y} dicts
    color: str
    width: float


# ─── App ─────────────────────────────────────────────────────────────────────

app = FastAPI(title=f"MiniRAFT Replica — {REPLICA_ID}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Debug / health ──────────────────────────────────────────────────────────


@app.get("/status")
def get_status():
    """
    Returns current node state. Used by gateway to discover leader.
    Also useful for the optional Phase 3 dashboard.
    """
    return {
        "node_id": state["node_id"],
        "role": state["role"],
        "current_term": state["current_term"],
        "leader_id": state["leader_id"],
        "log_length": len(state["log"]),
        "commit_index": state["commit_index"],
        "peers": state["peers"],
    }


# ─── RAFT RPC endpoints (Phase 1: stubs only) ────────────────────────────────


@app.post("/request-vote", response_model=VoteResponse)
def request_vote(req: VoteRequest):
    """
    RAFT RequestVote RPC.
    Phase 1: always deny — real election logic added in Phase 2.
    """
    log.info(
        "[%s] /request-vote | from=%s | their_term=%d | our_term=%d",
        REPLICA_ID,
        req.candidate_id,
        req.term,
        state["current_term"],
    )
    # TODO Phase 2: implement election rules
    #   - if req.term > current_term → update term, reset voted_for
    #   - grant vote if voted_for is None or req.candidate_id, and log is up-to-date
    return VoteResponse(term=state["current_term"], vote_granted=False)


@app.post("/append-entries", response_model=AppendEntriesResponse)
def append_entries(req: AppendEntriesRequest):
    """
    RAFT AppendEntries RPC.
    Phase 1: log receipt only — real replication logic added in Phase 2.
    """
    log.info(
        "[%s] /append-entries | from=%s | term=%d | entries=%d",
        REPLICA_ID,
        req.leader_id,
        req.term,
        len(req.entries),
    )
    # TODO Phase 2: implement log consistency check
    #   - reject if req.term < current_term
    #   - check prevLogIndex / prevLogTerm match
    #   - append new entries, update commit_index
    return AppendEntriesResponse(
        term=state["current_term"],
        success=False,
        match_index=None,
    )


@app.post("/heartbeat", response_model=HeartbeatResponse)
def heartbeat(req: HeartbeatRequest):
    """
    RAFT Heartbeat RPC.
    Phase 1: log receipt only — timer reset logic added in Phase 2.
    """
    log.info(
        "[%s] /heartbeat | from=%s | term=%d",
        REPLICA_ID,
        req.leader_id,
        req.term,
    )
    # TODO Phase 2:
    #   - update current_term if req.term is higher
    #   - reset election timeout timer
    #   - record leader_id
    return HeartbeatResponse(term=state["current_term"], success=True)


@app.post("/sync-log", response_model=SyncLogResponse)
def sync_log(req: SyncLogRequest):
    """
    Catch-up RPC. Called by a rejoining follower to request missing entries.
    Phase 1: returns empty — real sync logic added in Phase 3.
    """
    log.info(
        "[%s] /sync-log | requested_from_index=%d | our_log_length=%d",
        REPLICA_ID,
        req.from_index,
        len(state["log"]),
    )
    # TODO Phase 3: return state["log"][req.from_index:]
    return SyncLogResponse(entries=[], commit_index=state["commit_index"])


@app.post("/stroke")
def receive_stroke(payload: StrokePayload):
    """
    Called by gateway to submit a new stroke to the leader.
    Phase 1: log receipt only — real consensus logic added in Phase 2.
    """
    if state["role"] != NodeState.LEADER:
        log.warning(
            "[%s] /stroke received but I am not leader (role=%s)",
            REPLICA_ID,
            state["role"],
        )
        raise HTTPException(
            status_code=409,
            detail=f"{REPLICA_ID} is not the leader (role={state['role']})",
        )

    log.info(
        "[%s] /stroke | stroke_id=%s | color=%s | points=%d",
        REPLICA_ID,
        payload.stroke_id,
        payload.color,
        len(payload.points),
    )
    # TODO Phase 2:
    #   - append to local log
    #   - send AppendEntries to all peers
    #   - on majority ack → mark committed → notify gateway
    return {"status": "received", "node_id": REPLICA_ID}
