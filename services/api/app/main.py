import os
from typing import Dict, Any
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from .db import init_db
from .agents import make_moderator, make_participant, make_notetaker, simple_task
import httpx
from crewai import Crew

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

@app.on_event("startup")
async def _startup():
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

# In-memory session registry for MVP
SESSIONS: Dict[str, Dict[str, Any]] = {}

@app.get("/health/ollama")
async def health_ollama():
    base = os.getenv("OLLAMA_URL", "http://ollama:11434")
    url = base.rstrip('/') + "/api/tags"
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(url)
            ok = r.status_code == 200
            return {"ok": ok, "ollama_url": base, "status": r.status_code, "body": r.json() if ok else r.text}
    except Exception as e:
        detail = str(e) or repr(e)
        return {"ok": False, "ollama_url": base, "error": detail}

@app.post("/sessions")
async def create_session(body: SessionIn):
    sid = os.urandom(8).hex()
    SESSIONS[sid] = {"info": body.model_dump(), "phase": "discover", "agents": {}}
    return {"id": sid, "phase": "discover"}

@app.post("/sessions/{sid}/agents")
async def add_agent(sid: str, body: AgentIn):
    if sid not in SESSIONS:
        raise HTTPException(status_code=404, detail=f"Session '{sid}' not found")

    if body.role == "moderator":
        agent = make_moderator(model_hint=body.model_hint)
    elif body.role == "notetaker":
        agent = make_notetaker(model_hint=body.model_hint)
    else:
        agent = make_participant(body.name, body.trait, model_hint=body.model_hint)
    SESSIONS[sid]["agents"][body.name] = {"spec": body.model_dump()}
    # sanity: try a very short run to validate model connectivity
    t = simple_task(agent, "Reply 'ready' if you can hear me.")
    probe_crew = Crew(agents=[agent], tasks=[t])
    try:
        out = probe_crew.kickoff()
    except Exception as exc:
        detail = str(exc) or repr(exc)
        raise HTTPException(status_code=502, detail=f"Agent probe failed: {detail}")
    return {"ok": True, "probe": str(out)[:200]}
