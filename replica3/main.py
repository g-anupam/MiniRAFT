"""
MiniRAFT - Replica Node (Phase 3 — Reliability & Zero-Downtime)
================================================================
Phase 3 additions over Phase 2:
  - Catch-up sync: when AppendEntries fails with match_index, leader calls
    /sync-log on the lagging follower and pushes all missing committed entries
  - heartbeat_loop also triggers catch-up on followers that are behind
  - Graceful shutdown logging so hot-reload restarts are visible in logs

All Phase 2 behaviour is unchanged.
"""

import asyncio
import logging
import os
import random
from contextlib import asynccontextmanager
from enum import Enum
from typing import List, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("replica")

# ─── Config ──────────────────────────────────────────────────────────────────

REPLICA_ID: str  = os.getenv("REPLICA_ID", "replica-unknown")
PORT: int        = int(os.getenv("PORT", "9001"))
PEERS: List[str] = [p for p in os.getenv("PEERS", "").split(",") if p]
GATEWAY_URL: str = os.getenv("GATEWAY_URL", "http://gateway:8080")

ELECTION_TIMEOUT_MIN = 0.5    # seconds
ELECTION_TIMEOUT_MAX = 0.8
HEARTBEAT_INTERVAL   = 0.15   # seconds
RPC_TIMEOUT          = 0.5    # per-peer HTTP call timeout

# ─── Node state ──────────────────────────────────────────────────────────────

class NodeState(str, Enum):
    FOLLOWER  = "follower"
    CANDIDATE = "candidate"
    LEADER    = "leader"


state = {
    "node_id":      REPLICA_ID,
    "role":         NodeState.FOLLOWER,
    "current_term": 0,
    "voted_for":    None,   # candidate_id we voted for in current_term
    "leader_id":    None,
    "log":          [],     # [{"index": int, "term": int, "entry": dict}]
    "commit_index": -1,
}

# asyncio primitives — initialised in lifespan
heartbeat_event: asyncio.Event = None
state_lock: asyncio.Lock       = None

# background task handles
_election_task: asyncio.Task  = None
_heartbeat_task: asyncio.Task = None

# ─── Log helpers ─────────────────────────────────────────────────────────────

def last_log_index() -> int:
    return state["log"][-1]["index"] if state["log"] else -1


def last_log_term() -> int:
    return state["log"][-1]["term"] if state["log"] else 0


def is_log_up_to_date(their_last_index: int, their_last_term: int) -> bool:
    """True if candidate log is at least as up-to-date as ours (RAFT §5.4.1)."""
    my_last_term  = last_log_term()
    my_last_index = last_log_index()
    if their_last_term != my_last_term:
        return their_last_term > my_last_term
    return their_last_index >= my_last_index

# ─── State transitions ────────────────────────────────────────────────────────

async def step_down(new_term: int):
    """
    Revert to follower with new_term.
    Cancels the heartbeat sender if running.
    Wakes the election timer so it resets cleanly.
    Must be called while holding state_lock.
    """
    global _heartbeat_task
    state["role"]         = NodeState.FOLLOWER
    state["current_term"] = new_term
    state["voted_for"]    = None
    state["leader_id"]    = None
    log.info("[%s] Stepped down → FOLLOWER | term=%d", REPLICA_ID, new_term)
    if _heartbeat_task and not _heartbeat_task.done():
        _heartbeat_task.cancel()
    heartbeat_event.set()   # wake election timer so it resets

# ─── Catch-up sync ───────────────────────────────────────────────────────────

async def _sync_follower(peer_url: str, from_index: int):
    """
    Push all committed log entries from from_index onward to a lagging follower.

    Called by the leader when:
      (a) replicate_to() gets success=False with a match_index  (stroke path)
      (b) heartbeat_loop detects a follower is behind             (background path)

    The follower's /sync-log receives the entries and appends them all at once,
    bringing it fully up to date before normal AppendEntries resumes.
    """
    async with state_lock:
        if state["role"] != NodeState.LEADER:
            return
        committed = [
            e for e in state["log"]
            if e["index"] >= from_index and e["index"] <= state["commit_index"]
        ]
        commit_idx = state["commit_index"]

    if not committed:
        return

    log.info(
        "[%s] Syncing %s | from_index=%d | entries=%d",
        REPLICA_ID, peer_url, from_index, len(committed),
    )

    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{peer_url}/sync-log",
                json={
                    "from_index":   from_index,
                    "entries":      committed,
                    "commit_index": commit_idx,
                },
                timeout=2.0,
            )
        if r.status_code == 200:
            log.info(
                "[%s] Catch-up sync OK → %s | sent=%d entries",
                REPLICA_ID, peer_url, len(committed),
            )
        else:
            log.warning(
                "[%s] Catch-up sync failed → %s | status=%d",
                REPLICA_ID, peer_url, r.status_code,
            )
    except Exception as exc:
        log.warning("[%s] Catch-up sync error → %s: %s", REPLICA_ID, peer_url, exc)

async def _catch_up_from_leader(leader_url: str, from_index: int):
    """
    Follower-initiated sync: call the leader's /sync-log to request missing
    committed entries, then apply them locally.  This is the pull path described
    in the spec (Section 3.1B: /sync-log 'called by a rejoining node').
    """
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{leader_url}/sync-log",
                json={"from_index": from_index},
                timeout=3.0,
            )
        if r.status_code != 200:
            log.warning("[%s] Pull sync from %s failed | status=%d", REPLICA_ID, leader_url, r.status_code)
            return
        data         = r.json()
        entries      = data.get("entries", [])
        commit_index = data.get("commit_index", -1)
        if not entries:
            return
        async with state_lock:
            for e in entries:
                idx = e["index"]
                if idx >= len(state["log"]):
                    state["log"].append(e)
                elif state["log"][idx]["term"] != e["term"]:
                    state["log"] = state["log"][:idx]
                    state["log"].append(e)
            if commit_index > state["commit_index"]:
                state["commit_index"] = min(commit_index, last_log_index())
        log.info(
            "[%s] Pull sync OK from %s | applied=%d entries | commit_index → %d",
            REPLICA_ID, leader_url, len(entries), commit_index,
        )
    except Exception as exc:
        log.warning("[%s] Pull sync from %s error: %s", REPLICA_ID, leader_url, exc)

# ─── Election loop ────────────────────────────────────────────────────────────

async def election_loop():
    """
    Background task — runs for the lifetime of the process.

    Waits for heartbeat_event within a random 500-800 ms window.
    If the window expires without a heartbeat → start an election.
    """
    global _heartbeat_task
    log.info("[%s] Election timer started", REPLICA_ID)

    while True:
        heartbeat_event.clear()
        timeout = random.uniform(ELECTION_TIMEOUT_MIN, ELECTION_TIMEOUT_MAX)

        try:
            await asyncio.wait_for(heartbeat_event.wait(), timeout=timeout)
            # Heartbeat or vote-grant arrived — loop back and reset timer
            continue
        except asyncio.TimeoutError:
            pass

        async with state_lock:
            if state["role"] == NodeState.LEADER:
                heartbeat_event.set()
                continue

            # ── Become candidate ─────────────────────────────────────────────
            state["role"]          = NodeState.CANDIDATE
            state["current_term"] += 1
            state["voted_for"]     = REPLICA_ID
            state["leader_id"]     = None
            term    = state["current_term"]
            l_index = last_log_index()
            l_term  = last_log_term()

        log.info(
            "[%s] Election started | term=%d | last_log_index=%d",
            REPLICA_ID, term, l_index,
        )

        vote_req = {
            "term":           term,
            "candidate_id":   REPLICA_ID,
            "last_log_index": l_index,
            "last_log_term":  l_term,
        }

        async def request_vote_from(peer_url: str):
            try:
                async with httpx.AsyncClient() as client:
                    r = await client.post(
                        f"{peer_url}/request-vote",
                        json=vote_req,
                        timeout=RPC_TIMEOUT,
                    )
                return r.json()
            except Exception as exc:
                log.warning("[%s] RequestVote → %s failed: %s", REPLICA_ID, peer_url, exc)
                return None

        results = await asyncio.gather(*[request_vote_from(p) for p in PEERS])

        votes = 1   # always vote for ourselves
        stepped = False
        for result in results:
            if result is None:
                continue
            if result.get("term", 0) > term:
                async with state_lock:
                    await step_down(result["term"])
                stepped = True
                break
            if result.get("vote_granted"):
                votes += 1

        if stepped:
            continue

        async with state_lock:
            # Guard: only promote if still candidate in same term
            if state["role"] != NodeState.CANDIDATE or state["current_term"] != term:
                continue

            if votes >= 2:
                state["role"]      = NodeState.LEADER
                state["leader_id"] = REPLICA_ID
                log.info(
                    "[%s] *** BECAME LEADER *** | term=%d | votes=%d",
                    REPLICA_ID, term, votes,
                )
                _heartbeat_task = asyncio.create_task(heartbeat_loop())
                heartbeat_event.set()
            else:
                log.info(
                    "[%s] Election lost | term=%d | votes=%d — retrying",
                    REPLICA_ID, term, votes,
                )
                state["role"] = NodeState.FOLLOWER
                # Don't set heartbeat_event → timer fires again after next random delay

# ─── Heartbeat sender loop ────────────────────────────────────────────────────

async def heartbeat_loop():
    """
    Background task — runs only while this node is Leader.
    Sends POST /heartbeat to all peers every 150 ms.
    Steps down automatically if a peer reports a higher term.
    """
    log.info("[%s] Heartbeat loop started", REPLICA_ID)

    async def ping(peer_url: str, term: int):
        try:
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    f"{peer_url}/heartbeat",
                    json={"term": term, "leader_id": REPLICA_ID},
                    timeout=RPC_TIMEOUT,
                )
            data = r.json()
            if data.get("term", 0) > term:
                async with state_lock:
                    if data["term"] > state["current_term"]:
                        await step_down(data["term"])
        except Exception as exc:
            log.warning("[%s] Heartbeat → %s failed: %s", REPLICA_ID, peer_url, exc)

    # Track each follower's known match_index so we can detect lag
    # key: peer_url → last known match_index (-1 = unknown)
    peer_match: dict = {p: -1 for p in PEERS}

    while True:
        async with state_lock:
            if state["role"] != NodeState.LEADER:
                log.info("[%s] Heartbeat loop stopping — no longer leader", REPLICA_ID)
                return
            term       = state["current_term"]
            our_commit = state["commit_index"]

        await asyncio.gather(*[ping(p, term) for p in PEERS])

        # Phase 3: check if any follower is lagging behind our commit index.
        # We detect this by comparing peer_match (updated by replicate_to on
        # the stroke path) against our own commit_index.
        # If a follower is behind, push the missing entries via /sync-log.
        for peer_url in PEERS:
            known = peer_match.get(peer_url, -1)
            if known < our_commit:
                # Follower is behind — trigger catch-up asynchronously
                # so it doesn't block the heartbeat interval
                asyncio.create_task(_sync_follower(peer_url, known + 1))
                peer_match[peer_url] = our_commit   # optimistically update

        await asyncio.sleep(HEARTBEAT_INTERVAL)

# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_app: FastAPI):
    global heartbeat_event, state_lock, _election_task

    heartbeat_event = asyncio.Event()
    state_lock      = asyncio.Lock()

    log.info(
        "[%s] Booting | role=%s | term=%d | peers=%s",
        REPLICA_ID, state["role"], state["current_term"], PEERS,
    )

    _election_task = asyncio.create_task(election_loop())
    yield

    if _election_task and not _election_task.done():
        _election_task.cancel()
    if _heartbeat_task and not _heartbeat_task.done():
        _heartbeat_task.cancel()
    log.info("[%s] Shutdown complete", REPLICA_ID)

# ─── Pydantic schemas ─────────────────────────────────────────────────────────

class VoteRequest(BaseModel):
    term:           int
    candidate_id:   str
    last_log_index: int
    last_log_term:  int

class VoteResponse(BaseModel):
    term:         int
    vote_granted: bool

class LogEntry(BaseModel):
    index: int
    term:  int
    entry: dict

class AppendEntriesRequest(BaseModel):
    term:           int
    leader_id:      str
    prev_log_index: int
    prev_log_term:  int
    entries:        List[LogEntry]
    leader_commit:  int

class AppendEntriesResponse(BaseModel):
    term:        int
    success:     bool
    match_index: Optional[int] = None

class HeartbeatRequest(BaseModel):
    term:      int
    leader_id: str

class HeartbeatResponse(BaseModel):
    term:    int
    success: bool

class SyncLogRequest(BaseModel):
    from_index:   int
    entries:      Optional[List[LogEntry]] = None   # present on leader-push path
    commit_index: Optional[int]            = None   # present on leader-push path

class SyncLogResponse(BaseModel):
    entries:      List[LogEntry]
    commit_index: int

class StrokePayload(BaseModel):
    stroke_id: str
    type:      str = "stroke"   # "stroke" | "clear"
    points:    list = []
    color:     str = ""
    width:     float = 0

# ─── FastAPI app ──────────────────────────────────────────────────────────────

app = FastAPI(title=f"MiniRAFT Replica — {REPLICA_ID}", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/status")
async def get_status():
    return {
        "node_id":      state["node_id"],
        "role":         state["role"],
        "current_term": state["current_term"],
        "leader_id":    state["leader_id"],
        "log_length":   len(state["log"]),
        "commit_index": state["commit_index"],
        "peers":        PEERS,
    }


@app.post("/request-vote", response_model=VoteResponse)
async def request_vote(req: VoteRequest):
    async with state_lock:
        # Stale term → deny immediately
        if req.term < state["current_term"]:
            log.info(
                "[%s] Vote DENIED → %s | stale term %d < %d",
                REPLICA_ID, req.candidate_id, req.term, state["current_term"],
            )
            return VoteResponse(term=state["current_term"], vote_granted=False)

        # Higher term → step down and reset voted_for
        if req.term > state["current_term"]:
            state["current_term"] = req.term
            state["voted_for"]    = None
            state["role"]         = NodeState.FOLLOWER
            state["leader_id"]    = None

        # Already voted for someone else this term
        if state["voted_for"] is not None and state["voted_for"] != req.candidate_id:
            log.info(
                "[%s] Vote DENIED → %s | already voted for %s in term=%d",
                REPLICA_ID, req.candidate_id, state["voted_for"], req.term,
            )
            return VoteResponse(term=state["current_term"], vote_granted=False)

        # Candidate log must be at least as up-to-date as ours
        if not is_log_up_to_date(req.last_log_index, req.last_log_term):
            log.info(
                "[%s] Vote DENIED → %s | log not up-to-date",
                REPLICA_ID, req.candidate_id,
            )
            return VoteResponse(term=state["current_term"], vote_granted=False)

        state["voted_for"] = req.candidate_id
        heartbeat_event.set()   # reset our own election timer
        log.info(
            "[%s] Vote GRANTED → %s | term=%d",
            REPLICA_ID, req.candidate_id, req.term,
        )
        return VoteResponse(term=state["current_term"], vote_granted=True)


@app.post("/append-entries", response_model=AppendEntriesResponse)
async def append_entries(req: AppendEntriesRequest):
    async with state_lock:
        # Stale leader
        if req.term < state["current_term"]:
            return AppendEntriesResponse(term=state["current_term"], success=False)

        # Valid leader — accept authority
        if req.term > state["current_term"]:
            state["current_term"] = req.term
            state["voted_for"]    = None

        state["role"]      = NodeState.FOLLOWER
        state["leader_id"] = req.leader_id
        heartbeat_event.set()

        # Log consistency check
        if req.prev_log_index >= 0:
            if len(state["log"]) <= req.prev_log_index:
                our_len    = len(state["log"])
                leader_url = req.leader_id
                log.info(
                    "[%s] AppendEntries REJECT | missing prev_log_index=%d | our_len=%d — triggering pull sync",
                    REPLICA_ID, req.prev_log_index, our_len,
                )
                asyncio.create_task(_catch_up_from_leader(leader_url, our_len))
                return AppendEntriesResponse(
                    term=state["current_term"],
                    success=False,
                    match_index=our_len - 1,
                )

            if state["log"][req.prev_log_index]["term"] != req.prev_log_term:
                # Conflicting entry — truncate
                state["log"] = state["log"][:req.prev_log_index]
                log.info(
                    "[%s] AppendEntries REJECT | term mismatch at index=%d — truncated",
                    REPLICA_ID, req.prev_log_index,
                )
                return AppendEntriesResponse(
                    term=state["current_term"],
                    success=False,
                    match_index=req.prev_log_index - 1,
                )

        # Append entries (skip any already present with matching term)
        for e in req.entries:
            idx = e.index
            if idx < len(state["log"]):
                if state["log"][idx]["term"] != e.term:
                    state["log"] = state["log"][:idx]
                    state["log"].append(e.dict())
            else:
                state["log"].append(e.dict())

        # Advance commit index
        if req.leader_commit > state["commit_index"]:
            state["commit_index"] = min(req.leader_commit, last_log_index())
            log.info("[%s] commit_index → %d", REPLICA_ID, state["commit_index"])

        return AppendEntriesResponse(
            term=state["current_term"],
            success=True,
            match_index=last_log_index(),
        )


@app.post("/heartbeat", response_model=HeartbeatResponse)
async def heartbeat(req: HeartbeatRequest):
    async with state_lock:
        if req.term < state["current_term"]:
            return HeartbeatResponse(term=state["current_term"], success=False)

        if req.term > state["current_term"]:
            state["current_term"] = req.term
            state["voted_for"]    = None

        state["role"]      = NodeState.FOLLOWER
        state["leader_id"] = req.leader_id
        heartbeat_event.set()

        return HeartbeatResponse(term=state["current_term"], success=True)


@app.post("/sync-log", response_model=SyncLogResponse)
async def sync_log(req: SyncLogRequest):
    """
    Dual-mode endpoint:

    Pull path (entries=None): a rejoining follower calls this on the leader.
      The leader returns its committed entries from from_index onward.
      Spec ref: Section 3.1B — '/sync-log called by a rejoining node'.

    Push path (entries provided): the leader calls this on a lagging follower,
      pushing all missing committed entries so the follower can apply them.
      Triggered by heartbeat_loop via _sync_follower().
    """
    async with state_lock:
        if req.entries is not None:
            # Push path — apply entries sent by the leader
            for e in req.entries:
                entry_dict = e.dict()
                idx = entry_dict["index"]
                if idx >= len(state["log"]):
                    state["log"].append(entry_dict)
                elif state["log"][idx]["term"] != entry_dict["term"]:
                    state["log"] = state["log"][:idx]
                    state["log"].append(entry_dict)
            if req.commit_index is not None and req.commit_index > state["commit_index"]:
                state["commit_index"] = min(req.commit_index, last_log_index())
            log.info(
                "[%s] /sync-log push | applied=%d entries | commit_index → %d",
                REPLICA_ID, len(req.entries), state["commit_index"],
            )
            return SyncLogResponse(entries=[], commit_index=state["commit_index"])
        else:
            # Pull path — return our committed entries to the calling follower
            committed = [
                e for e in state["log"]
                if e["index"] >= req.from_index and e["index"] <= state["commit_index"]
            ]
            log.info(
                "[%s] /sync-log pull | from=%d | sending=%d entries",
                REPLICA_ID, req.from_index, len(committed),
            )
            return SyncLogResponse(
                entries=[LogEntry(**e) for e in committed],
                commit_index=state["commit_index"],
            )


@app.post("/stroke")
async def receive_stroke(payload: StrokePayload):
    """
    Gateway submits a new stroke to the leader.

    Flow:
      1. Append to local log
      2. Send AppendEntries to all peers concurrently
      3. Majority ack → mark committed, advance commit_index
      4. Notify gateway POST /committed-stroke → broadcast to clients
    """
    async with state_lock:
        if state["role"] != NodeState.LEADER:
            raise HTTPException(
                status_code=409,
                detail=f"{REPLICA_ID} is not the leader (role={state['role']})",
            )
        term      = state["current_term"]
        new_index = last_log_index() + 1
        prev_idx  = new_index - 1
        prev_term = state["log"][prev_idx]["term"] if prev_idx >= 0 and state["log"] else 0
        commit_idx = state["commit_index"]

        new_entry = {"index": new_index, "term": term, "entry": payload.dict()}
        state["log"].append(new_entry)
        log.info(
            "[%s] Stroke appended | index=%d | stroke_id=%s",
            REPLICA_ID, new_index, payload.stroke_id,
        )

    ae_req = {
        "term":           term,
        "leader_id":      REPLICA_ID,
        "prev_log_index": prev_idx,
        "prev_log_term":  prev_term,
        "entries":        [new_entry],
        "leader_commit":  commit_idx,
    }

    async def replicate_to(peer_url: str) -> bool:
        try:
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    f"{peer_url}/append-entries",
                    json=ae_req,
                    timeout=RPC_TIMEOUT,
                )
            data = r.json()
            if data.get("term", 0) > term:
                async with state_lock:
                    if data["term"] > state["current_term"]:
                        await step_down(data["term"])
                return False
            if data.get("success", False):
                return True
            # Follower rejected — it's behind. Trigger catch-up asynchronously.
            # match_index tells us where the follower's log ends.
            their_match = data.get("match_index", -1)
            log.info(
                "[%s] Follower %s is behind (match_index=%d) — scheduling catch-up",
                REPLICA_ID, peer_url, their_match,
            )
            asyncio.create_task(_sync_follower(peer_url, their_match + 1))
            return False
        except Exception as exc:
            log.warning(
                "[%s] AppendEntries → %s failed: %s", REPLICA_ID, peer_url, exc
            )
            return False

    results = await asyncio.gather(*[replicate_to(p) for p in PEERS])
    acks = 1 + sum(1 for r in results if r)   # 1 = self

    if acks >= 2:
        async with state_lock:
            if state["role"] == NodeState.LEADER:
                state["commit_index"] = new_index
                log.info(
                    "[%s] Stroke COMMITTED | index=%d | acks=%d | stroke_id=%s",
                    REPLICA_ID, new_index, acks, payload.stroke_id,
                )

        await _notify_gateway(payload.dict())
        return {"status": "committed", "index": new_index, "acks": acks}

    log.warning(
        "[%s] Stroke NOT committed | acks=%d | stroke_id=%s",
        REPLICA_ID, acks, payload.stroke_id,
    )
    raise HTTPException(
        status_code=503,
        detail=f"Replication failed — only {acks} acks (need 2)",
    )


async def _notify_gateway(stroke: dict):
    """POST committed stroke to gateway so it broadcasts to all WS clients."""
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{GATEWAY_URL}/committed-stroke",
                json=stroke,
                timeout=RPC_TIMEOUT,
            )
        log.info("[%s] Gateway notified | stroke_id=%s", REPLICA_ID, stroke.get("stroke_id"))
    except Exception as exc:
        log.warning("[%s] Gateway notify failed: %s", REPLICA_ID, exc)
