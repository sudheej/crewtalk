import asyncio
import datetime as dt
import os
from typing import Any, Dict, Optional

import httpx
from crewai import Crew
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from redis import asyncio as aioredis

from .agents import make_moderator, make_notetaker, make_participant, simple_task
from .db import init_db
from .engine import repo as engine_repo
from .engine.session_engine import SessionEngine
from .engine.ws import session_broadcaster

app = FastAPI(title="Crew Talk API")

# CORS
raw_origins = os.getenv("CORS_ORIGIN", "*")
origin_tokens = [token.strip() for token in raw_origins.split(",") if token.strip() and token.strip() != "*"]
cors_kwargs: dict[str, Any] = {
    "allow_methods": ["*"],
    "allow_headers": ["*"],
    "allow_credentials": True,
}
if origin_tokens:
    cors_kwargs["allow_origins"] = origin_tokens
else:
    cors_kwargs["allow_origins"] = []
    cors_kwargs["allow_origin_regex"] = r"https?://.*"
app.add_middleware(CORSMiddleware, **cors_kwargs)


REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)


@app.on_event("startup")
async def _startup() -> None:
    init_db()


class SessionIn(BaseModel):
    title: str
    problem_statement: str
    time_limit_sec: int = 900
    strategy: str = "double_diamond"


class AgentIn(BaseModel):
    name: str
    role: str  # moderator|participant|notetaker
    trait: str = ""
    model_hint: str | None = None


class NotepadIn(BaseModel):
    content: str
    updated_by: str | None = None


ENGINE_CACHE: Dict[str, SessionEngine] = {}


def get_engine(session_id: str) -> SessionEngine:
    engine = ENGINE_CACHE.get(session_id)
    if not engine:
        engine = SessionEngine(session_id)
        ENGINE_CACHE[session_id] = engine
    return engine


async def ensure_session_or_404(session_id: str) -> Dict[str, Any]:
    record = await engine_repo.get_session(session_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Session '{session_id}' not found")
    return record


def notepad_key(session_id: str) -> str:
    return f"session:{session_id}:notepad"


@app.get("/health/ollama")
async def health_ollama():
    base = os.getenv("OLLAMA_URL", "http://ollama:11434")
    url = base.rstrip("/") + "/api/tags"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(url)
            ok = r.status_code == 200
            return {
                "ok": ok,
                "ollama_url": base,
                "status": r.status_code,
                "body": r.json() if ok else r.text,
            }
    except Exception as exc:
        detail = str(exc) or repr(exc)
        return {"ok": False, "ollama_url": base, "error": detail}


@app.post("/sessions", status_code=201)
async def create_session(body: SessionIn):
    record = await engine_repo.create_session(
        body.title,
        body.problem_statement,
        body.time_limit_sec,
        body.strategy,
    )
    return {"id": record["id"], "phase": record["phase"], "status": record["status"]}


@app.post("/sessions/{sid}/agents")
async def add_agent(sid: str, body: AgentIn):
    await ensure_session_or_404(sid)
    if body.role == "moderator":
        agent = make_moderator(model_hint=body.model_hint)
    elif body.role == "notetaker":
        agent = make_notetaker(model_hint=body.model_hint)
    else:
        agent = make_participant(body.name, body.trait, model_hint=body.model_hint)

    task = simple_task(agent, "Reply 'ready' if you can hear me.")
    probe_crew = Crew(agents=[agent], tasks=[task])
    try:
        probe_output = probe_crew.kickoff()
    except Exception as exc:
        detail = str(exc) or repr(exc)
        raise HTTPException(status_code=502, detail=f"Agent probe failed: {detail}")

    await engine_repo.add_agent(
        sid,
        body.name,
        body.role,
        body.trait or None,
        body.model_hint or None,
    )
    return {"ok": True, "probe": str(probe_output)[:200]}


@app.post("/sessions/{sid}/start")
async def start_session(sid: str):
    await ensure_session_or_404(sid)
    engine = get_engine(sid)
    await engine.start()
    meta = await engine_repo.get_session(sid)
    return {"ok": True, "phase": meta["phase"], "status": meta["status"]}


@app.post("/sessions/{sid}/pause")
async def pause_session(sid: str):
    await ensure_session_or_404(sid)
    engine = get_engine(sid)
    await engine.pause()
    meta = await engine_repo.get_session(sid)
    return {"ok": True, "status": meta["status"]}


@app.post("/sessions/{sid}/resume")
async def resume_session(sid: str):
    await ensure_session_or_404(sid)
    engine = get_engine(sid)
    await engine.resume()
    meta = await engine_repo.get_session(sid)
    return {"ok": True, "status": meta["status"]}


@app.post("/sessions/{sid}/stop")
async def stop_session(sid: str):
    await ensure_session_or_404(sid)
    engine = get_engine(sid)
    await engine.stop()
    meta = await engine_repo.get_session(sid)
    return {"ok": True, "status": meta["status"]}


@app.post("/sessions/{sid}/advance")
async def advance_session(sid: str):
    await ensure_session_or_404(sid)
    engine = get_engine(sid)
    await engine.advance_phase()
    meta = await engine_repo.get_session(sid)
    return {"ok": True, "phase": meta["phase"], "status": meta["status"]}


@app.post("/sessions/{sid}/notepad")
async def update_notepad(sid: str, body: NotepadIn):
    await ensure_session_or_404(sid)
    await redis_client.set(notepad_key(sid), body.content)
    await engine_repo.save_notepad_snapshot(sid, body.content, body.updated_by)
    await session_broadcaster.emit(
        sid,
        "notepad.updated",
        {"content": body.content, "updated_by": body.updated_by},
    )
    return {"ok": True}


@app.websocket("/sessions/{sid}/stream")
async def session_stream(sid: str, websocket: WebSocket):
    try:
        await ensure_session_or_404(sid)
    except HTTPException:
        await websocket.close(code=4040)
        return

    await websocket.accept()

    initial_meta = await engine_repo.get_session(sid)
    if initial_meta:
        await websocket.send_json(
            {
                "event": "session.status",
                "session_id": sid,
                "payload": {
                    "status": initial_meta["status"],
                    "phase": initial_meta["phase"],
                    "turn_index": initial_meta["turn_index"],
                    "deadline": initial_meta.get("deadline"),
                },
                "ts": dt.datetime.utcnow().timestamp(),
            }
        )

    queue = await session_broadcaster.register(sid)
    try:
        while True:
            event = await queue.get()
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    finally:
        await session_broadcaster.unregister(sid, queue)


@app.get("/sessions/{sid}")
async def get_session_detail(sid: str):
    session_row = await ensure_session_or_404(sid)
    agents = await engine_repo.list_agents(sid)
    turns = await engine_repo.recent_messages(sid, limit=50)
    notepad = await redis_client.get(notepad_key(sid))
    return {
        "id": session_row["id"],
        "title": session_row["title"],
        "phase": session_row["phase"],
        "status": session_row["status"],
        "deadline": session_row.get("deadline"),
        "strategy": session_row["strategy"],
        "time_limit_sec": session_row["time_limit_sec"],
        "agents": agents,
        "turns": turns,
        "notepad": notepad or "",
    }


@app.get("/sessions/{sid}/export")
async def export_session(sid: str):
    await ensure_session_or_404(sid)
    payload = await engine_repo.export_session(sid)
    latest_notepad = await redis_client.get(notepad_key(sid))
    payload["notepad_latest"] = latest_notepad or ""
    return payload
