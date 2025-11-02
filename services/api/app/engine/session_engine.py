from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

from redis import asyncio as aioredis

from ..llm import DEFAULT_MODEL, OLLAMA_URL
from . import repo
from .llm_stream import stream_chat
from .strategy import DoubleDiamondPhase, get_phases, phase_prompt
from .ws import session_broadcaster

logger = logging.getLogger(__name__)

REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379/0")
_redis = aioredis.from_url(REDIS_URL, decode_responses=True)

SHORT_TERM_LIMIT = 8
NOTETAKER_INTERVAL = 2


POSITIVE_WORDS = {
    "great",
    "good",
    "excellent",
    "positive",
    "promising",
    "excited",
    "glad",
    "happy",
    "optimistic",
}
NEGATIVE_WORDS = {
    "bad",
    "concern",
    "worried",
    "negative",
    "risky",
    "uncertain",
    "problem",
    "issue",
    "doubt",
    "frustrated",
    "blocked",
}
HEDGE_WORDS = {
    "maybe",
    "perhaps",
    "possibly",
    "unsure",
    "might",
    "could",
    "guess",
    "uncertain",
    "probably",
}

CONFIDENCE_RE = re.compile(r"confidence[:\s]+([01](?:\.\d+)?)", re.IGNORECASE)


class SessionEngine:
    """Coordinates a multi-agent session with streaming updates."""

    def __init__(self, session_id: str, *, max_turns_per_phase: int = 8) -> None:
        self.sid = session_id
        self.status: str = "idle"
        self.phase: str = "discover"
        self.turn_index: int = 0
        self.max_turns_per_phase = max_turns_per_phase
        self.phase_deadline: Optional[dt.datetime] = None

        self._agents: List[Dict[str, Any]] = []
        self._moderator: Optional[Dict[str, Any]] = None
        self._note_taker: Optional[Dict[str, Any]] = None
        self._participants: List[Dict[str, Any]] = []

        self._task: Optional[asyncio.Task] = None
        self._pause_event = asyncio.Event()
        self._pause_event.set()
        self._stop_requested = False
        self._advance_requested = False
        self._lock = asyncio.Lock()

    # --- Public controls -------------------------------------------------

    async def start(self) -> None:
        async with self._lock:
            if self._task and not self._task.done():
                raise RuntimeError("session already running")

            meta = await repo.get_session(self.sid)
            if not meta:
                raise ValueError(f"Session {self.sid} not found")
            agents = await repo.list_agents(self.sid)
            self._configure_agents(agents)
            if not self._moderator or not self._participants:
                raise RuntimeError(
                    "Session requires at least one moderator and one participant before starting"
                )

            self.status = "running"
            self.phase = meta.get("phase", "discover")
            self.turn_index = meta.get("turn_index", 0) or 0
            self._stop_requested = False
            self._advance_requested = False
            self._pause_event.set()

            await repo.update_session(
                self.sid,
                status="running",
                phase=self.phase,
                turn_index=self.turn_index,
            )
            await session_broadcaster.emit(
                self.sid,
                "session.status",
                self._status_payload(),
            )

            self._task = asyncio.create_task(self._run(meta))

    async def pause(self) -> None:
        async with self._lock:
            if self.status != "running":
                return
            self.status = "paused"
            self._pause_event.clear()
            await repo.update_session(self.sid, status="paused")
            await session_broadcaster.emit(
                self.sid,
                "session.status",
                self._status_payload(),
            )

    async def resume(self) -> None:
        async with self._lock:
            if self.status != "paused":
                return
            self.status = "running"
            self._pause_event.set()
            await repo.update_session(self.sid, status="running")
            await session_broadcaster.emit(
                self.sid,
                "session.status",
                self._status_payload(),
            )

    async def stop(self) -> None:
        async with self._lock:
            if self.status in {"done", "idle"} and not self._task:
                return
            self._stop_requested = True
            self._pause_event.set()
            self.status = "done"
            await repo.update_session(
                self.sid,
                status="done",
                ended_at=dt.datetime.utcnow().isoformat(),
            )
            await session_broadcaster.emit(
                self.sid,
                "session.status",
                self._status_payload(),
            )
            if self._task:
                self._task.cancel()

    async def advance_phase(self) -> None:
        self._advance_requested = True
        self._pause_event.set()

    # --- Internal orchestration -----------------------------------------

    def _configure_agents(self, agents: List[Dict[str, Any]]) -> None:
        normalized: List[Dict[str, Any]] = []
        for agent in agents:
            entry = dict(agent)
            if entry.get("id") is not None:
                entry["id"] = str(entry["id"])
            if entry.get("session_id") is not None:
                entry["session_id"] = str(entry["session_id"])
            normalized.append(entry)
        self._agents = normalized
        self._moderator = next((a for a in normalized if a["role"] == "moderator"), None)
        self._note_taker = next((a for a in normalized if a["role"] == "notetaker"), None)
        self._participants = [a for a in normalized if a["role"] == "participant"]

    async def _run(self, meta: Dict[str, Any]) -> None:
        try:
            strategy = meta.get("strategy", "double_diamond")
            total_time = meta.get("time_limit_sec", 900) or 900
            if strategy != "double_diamond":
                logger.warning("Strategy %s unsupported, falling back to double_diamond", strategy)
            phases = get_phases(total_time)
            current_phase_index = next(
                (idx for idx, p in enumerate(phases) if p.name == self.phase),
                0,
            )

            for idx in range(current_phase_index, len(phases)):
                phase = phases[idx]
                if self._stop_requested:
                    break
                await self._pause_event.wait()
                if self._stop_requested:
                    break
                await self._run_phase_loop(phase)
                if self._stop_requested:
                    break
            self.status = "done"
        except asyncio.CancelledError:
            logger.info("Session %s runner cancelled", self.sid)
            raise
        except Exception as exc:
            logger.exception("Session %s crashed: %s", self.sid, exc)
            await session_broadcaster.emit(
                self.sid,
                "error",
                {"scope": "session", "message": "engine crashed", "details": str(exc)},
            )
        finally:
            await repo.update_session(
                self.sid,
                status="done",
                turn_index=self.turn_index,
                phase=self.phase,
                deadline=None,
                ended_at=dt.datetime.utcnow().isoformat(),
            )
            await session_broadcaster.emit(
                self.sid,
                "session.status",
                self._status_payload(),
            )

    async def _run_phase_loop(self, phase: DoubleDiamondPhase) -> None:
        previous_phase = self.phase
        self.phase = phase.name
        now = dt.datetime.utcnow()
        self.phase_deadline = now + dt.timedelta(seconds=phase.duration_sec)
        await repo.update_session(
            self.sid,
            phase=self.phase,
            deadline=self.phase_deadline.isoformat(),
        )
        await session_broadcaster.emit(
            self.sid,
            "phase.changed",
            {
                "from": previous_phase,
                "to": self.phase,
                "deadline": self.phase_deadline.isoformat(),
            },
        )
        await session_broadcaster.emit(
            self.sid,
            "session.status",
            self._status_payload(),
        )

        cycles = 0
        while cycles < self.max_turns_per_phase and not self._stop_requested:
            await self._pause_event.wait()
            if self._stop_requested:
                break
            if self._advance_requested:
                logger.info("Session %s manual advance requested", self.sid)
                self._advance_requested = False
                break
            if self.phase_deadline and dt.datetime.utcnow() > self.phase_deadline:
                logger.info("Session %s phase %s reached deadline", self.sid, self.phase)
                break

            await self._turn_for_agent(self._moderator, phase)
            for participant in self._participants:
                await self._turn_for_agent(participant, phase)

            if self._note_taker and (cycles + 1) % NOTETAKER_INTERVAL == 0:
                await self._turn_for_agent(self._note_taker, phase, notepad_mode=True)

            cycles += 1

        # Moderator summary at end of phase
        if self._moderator and not self._stop_requested:
            await self._turn_for_agent(
                self._moderator,
                phase,
                summary_mode=True,
            )

    async def _turn_for_agent(
        self,
        agent: Optional[Dict[str, Any]],
        phase: DoubleDiamondPhase,
        *,
        notepad_mode: bool = False,
        summary_mode: bool = False,
    ) -> None:
        if not agent or self._stop_requested:
            return

        await self._pause_event.wait()
        if self._stop_requested:
            return
        if self.status == "paused":
            return

        agent_id = agent["id"]
        role = agent["role"]
        trait = agent.get("trait") or ""
        model_tag = agent.get("model_hint") or DEFAULT_MODEL
        model = f"ollama/{model_tag}"

        memories = await self._collect_memories()
        notepad = await _redis.get(self._notepad_key())

        user_prompt = self._build_prompt(
            agent=agent,
            phase=phase,
            memories=memories,
            notepad=notepad or "",
            notepad_mode=notepad_mode,
            summary_mode=summary_mode,
        )

        messages = [
            {
                "role": "system",
                "content": phase_prompt(phase.name),
            },
            {
                "role": "user",
                "content": user_prompt,
            },
        ]

        self.turn_index += 1
        await repo.update_session(self.sid, turn_index=self.turn_index)
        await session_broadcaster.emit(
            self.sid,
            "session.status",
            self._status_payload(),
        )

        text_accum = ""
        try:
            async for delta in stream_chat(
                model,
                messages,
                base_url=OLLAMA_URL,
                temperature=0.2,
            ):
                text_accum += delta
                await session_broadcaster.emit(
                    self.sid,
                    "token.delta",
                    {
                        "agent_id": agent_id,
                        "turn_index": self.turn_index,
                        "text_delta": delta,
                    },
                )
        except Exception as exc:
            logger.exception("LLM streaming failed for session %s agent %s: %s", self.sid, agent_id, exc)
            await session_broadcaster.emit(
                self.sid,
                "error",
                {
                    "scope": "agent",
                    "message": f"{agent['name']} generation failed",
                    "details": str(exc),
                },
            )
            return

        text = text_accum.strip()
        if not text:
            text = "[no response]"

        sentiment = self._sentiment_score(text)
        confidence = self._confidence_score(text)

        message_id = await repo.save_message(
            self.sid,
            agent_id,
            self.phase,
            self.turn_index,
            text,
            sentiment,
            confidence,
        )

        await self._append_memory(agent, text)

        await session_broadcaster.emit(
            self.sid,
            "message.created",
            {
                "id": message_id,
                "agent_id": agent_id,
                "phase": self.phase,
                "turn_index": self.turn_index,
                "text": text,
                "sentiment": sentiment,
                "confidence": confidence,
                "created_at": dt.datetime.utcnow().isoformat(),
            },
        )

    # --- Helpers ---------------------------------------------------------

    def _status_payload(self) -> Dict[str, Any]:
        deadline_iso = self.phase_deadline.isoformat() if self.phase_deadline else None
        return {
            "status": self.status,
            "phase": self.phase,
            "turn_index": self.turn_index,
            "deadline": deadline_iso,
        }

    def _notepad_key(self) -> str:
        return f"session:{self.sid}:notepad"

    def _memory_key(self, agent_name: str) -> str:
        return f"session:{self.sid}:scratch:{agent_name}"

    async def _collect_memories(self) -> List[Dict[str, Any]]:
        keys = [self._memory_key(agent["name"]) for agent in self._agents]
        if not keys:
            return []

        async def _fetch(key: str) -> List[Dict[str, Any]]:
            items = await _redis.lrange(key, 0, SHORT_TERM_LIMIT - 1)
            if not items:
                return []
            parsed = []
            for item in reversed(items):  # lpush stores newest first
                try:
                    parsed.append(json.loads(item))
                except json.JSONDecodeError:
                    continue
            return parsed

        results = await asyncio.gather(*(_fetch(key) for key in keys))
        merged: List[Dict[str, Any]] = []
        for entries in results:
            merged.extend(entries)
        merged = sorted(merged, key=lambda entry: entry.get("turn_index", 0))
        return merged[-SHORT_TERM_LIMIT:]

    async def _append_memory(self, agent: Dict[str, Any], text: str) -> None:
        key = self._memory_key(agent["name"])
        entry = json.dumps(
            {
                "agent": agent["name"],
                "role": agent["role"],
                "turn_index": self.turn_index,
                "text": text,
            }
        )
        await _redis.lpush(key, entry)
        await _redis.ltrim(key, 0, SHORT_TERM_LIMIT - 1)

    def _build_prompt(
        self,
        *,
        agent: Dict[str, Any],
        phase: DoubleDiamondPhase,
        memories: List[Dict[str, Any]],
        notepad: str,
        notepad_mode: bool,
        summary_mode: bool,
    ) -> str:
        lines = [
            f"Session phase: {phase.name.upper()} — {phase.objective}",
            f"You are {agent['name']} ({agent['role']}).",
        ]
        trait = agent.get("trait")
        if trait:
            lines.append(f"Trait guidance: {trait}.")
        if summary_mode:
            lines.append("Provide a concise summary that transitions to the next phase.")
        elif notepad_mode:
            lines.append("Update the shared notepad with key decisions and TODOs.")
        else:
            lines.append("Respond succinctly (<=120 words). Advance the team's progress.")

        if memories:
            lines.append("\nRecent dialogue:")
            for mem in memories[-SHORT_TERM_LIMIT:]:
                lines.append(f"- {mem.get('agent', 'unknown')}: {mem.get('text', '')[:260]}")

        if notepad:
            preview = notepad.strip()
            if len(preview) > 400:
                preview = preview[:400] + "…"
            lines.append(f"\nNotepad snapshot:\n{preview}")

        lines.append("\nState your confidence as `Confidence: <value between 0 and 1>`.")
        return "\n".join(lines)

    def _sentiment_score(self, text: str) -> float:
        text_lower = text.lower()
        pos = sum(1 for word in POSITIVE_WORDS if word in text_lower)
        neg = sum(1 for word in NEGATIVE_WORDS if word in text_lower)
        if pos == neg == 0:
            return 0.0
        score = (pos - neg) / max(pos + neg, 1)
        return max(-1.0, min(1.0, score))

    def _confidence_score(self, text: str) -> float:
        match = CONFIDENCE_RE.search(text)
        user_conf = float(match.group(1)) if match else None

        text_lower = text.lower()
        hedges = sum(1 for word in HEDGE_WORDS if word in text_lower)
        auto_conf = max(0.0, min(1.0, 1.0 - 0.15 * hedges))

        if user_conf is not None:
            return round(0.6 * user_conf + 0.4 * auto_conf, 3)
        return round(auto_conf, 3)
