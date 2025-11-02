import asyncio
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy import text

from ..db import SessionLocal


def _dictify(row: Any) -> Dict[str, Any]:
    if row is None:
        return {}
    if isinstance(row, dict):
        return dict(row)
    if hasattr(row, "_mapping"):
        return dict(row._mapping)
    return dict(row)


async def create_session(
    title: str, problem_statement: str, time_limit_sec: int, strategy: str
) -> Dict[str, Any]:
    def _create() -> Dict[str, Any]:
        with SessionLocal() as session:
            result = session.execute(
                text(
                    """
                    insert into sessions (title, problem_statement, time_limit_sec, strategy)
                    values (:title, :problem_statement, :time_limit_sec, :strategy)
                    returning id, title, problem_statement, time_limit_sec, strategy, phase, status, deadline
                    """
                ),
                {
                    "title": title,
                    "problem_statement": problem_statement,
                    "time_limit_sec": time_limit_sec,
                    "strategy": strategy,
                },
            )
            row = result.mappings().one()
            session.commit()
            return dict(row)

    return await asyncio.to_thread(_create)


async def get_session(session_id: str) -> Optional[Dict[str, Any]]:
    def _get() -> Optional[Dict[str, Any]]:
        with SessionLocal() as session:
            result = session.execute(
                text(
                    """
                    select id, title, problem_statement, strategy, phase, status,
                           time_limit_sec, turn_index, deadline, started_at, ended_at
                    from sessions
                    where id = :session_id
                    """
                ),
                {"session_id": session_id},
            )
            row = result.mappings().one_or_none()
            return dict(row) if row else None

    return await asyncio.to_thread(_get)


async def update_session(
    session_id: str,
    *,
    phase: Optional[str] = None,
    status: Optional[str] = None,
    turn_index: Optional[int] = None,
    deadline: Optional[str] = None,
    ended_at: Optional[str] = None,
) -> None:
    fields: Dict[str, Any] = {}
    if phase is not None:
        fields["phase"] = phase
    if status is not None:
        fields["status"] = status
    if turn_index is not None:
        fields["turn_index"] = turn_index
    if deadline is not None:
        fields["deadline"] = deadline
    if ended_at is not None:
        fields["ended_at"] = ended_at

    if not fields:
        return

    assignments = ", ".join(f"{col} = :{col}" for col in fields.keys())
    params = {"session_id": session_id, **fields}

    def _update() -> None:
        with SessionLocal() as session:
            session.execute(
                text(
                    f"update sessions set {assignments} where id = :session_id"
                ),
                params,
            )
            session.commit()

    await asyncio.to_thread(_update)


async def add_agent(
    session_id: str,
    name: str,
    role: str,
    trait: Optional[str],
    model_hint: Optional[str],
) -> Dict[str, Any]:
    def _insert() -> Dict[str, Any]:
        with SessionLocal() as session:
            result = session.execute(
                text(
                    """
                    insert into agents (session_id, name, role, trait, model_hint)
                    values (:session_id, :name, :role, :trait, :model_hint)
                    returning id, session_id, name, role, trait, model_hint, created_at
                    """
                ),
                {
                    "session_id": session_id,
                    "name": name,
                    "role": role,
                    "trait": trait,
                    "model_hint": model_hint,
                },
            )
            row = result.mappings().one()
            session.commit()
            return dict(row)

    return await asyncio.to_thread(_insert)


async def list_agents(session_id: str) -> List[Dict[str, Any]]:
    def _list() -> List[Dict[str, Any]]:
        with SessionLocal() as session:
            result = session.execute(
                text(
                    """
                    select id, session_id, name, role, trait, model_hint, is_active, created_at
                    from agents
                    where session_id = :session_id
                    order by created_at asc
                    """
                ),
                {"session_id": session_id},
            )
            return [dict(row) for row in result.mappings().all()]

    return await asyncio.to_thread(_list)


async def save_message(
    session_id: str,
    agent_id: Optional[str],
    phase: str,
    turn_index: int,
    text: str,
    sentiment: Optional[float],
    confidence: Optional[float],
) -> int:
    def _save() -> int:
        with SessionLocal() as session:
            result = session.execute(
                text(
                    """
                    insert into messages (session_id, agent_id, phase, turn_index, text, sentiment, confidence)
                    values (:session_id, :agent_id, :phase, :turn_index, :text, :sentiment, :confidence)
                    returning id
                    """
                ),
                {
                    "session_id": session_id,
                    "agent_id": agent_id,
                    "phase": phase,
                    "turn_index": turn_index,
                    "text": text,
                    "sentiment": sentiment,
                    "confidence": confidence,
                },
            )
            row = result.scalar_one()
            session.commit()
            return int(row)

    return await asyncio.to_thread(_save)


async def recent_messages(session_id: str, limit: int = 50) -> List[Dict[str, Any]]:
    def _recent() -> List[Dict[str, Any]]:
        with SessionLocal() as session:
            result = session.execute(
                text(
                    """
                    select id, session_id, agent_id, phase, turn_index, text, sentiment, confidence, created_at
                    from messages
                    where session_id = :session_id
                    order by created_at desc
                    limit :limit
                    """
                ),
                {"session_id": session_id, "limit": limit},
            )
            rows = [dict(row) for row in result.mappings().all()]
            rows.reverse()
            return rows

    return await asyncio.to_thread(_recent)


async def list_messages(session_id: str) -> List[Dict[str, Any]]:
    def _list() -> List[Dict[str, Any]]:
        with SessionLocal() as session:
            result = session.execute(
                text(
                    """
                    select id, session_id, agent_id, phase, turn_index, text, sentiment, confidence, created_at
                    from messages
                    where session_id = :session_id
                    order by created_at asc
                    """
                ),
                {"session_id": session_id},
            )
            return [dict(row) for row in result.mappings().all()]

    return await asyncio.to_thread(_list)


async def save_notepad_snapshot(session_id: str, content: str, updated_by: Optional[str]) -> None:
    def _save() -> None:
        with SessionLocal() as session:
            session.execute(
                text(
                    """
                    insert into notepad_snapshots (session_id, content, updated_by)
                    values (:session_id, :content, :updated_by)
                    """
                ),
                {"session_id": session_id, "content": content, "updated_by": updated_by},
            )
            session.commit()

    await asyncio.to_thread(_save)


async def list_notepad_snapshots(session_id: str) -> List[Dict[str, Any]]:
    def _list() -> List[Dict[str, Any]]:
        with SessionLocal() as session:
            result = session.execute(
                text(
                    """
                    select id, session_id, content, updated_by, created_at
                    from notepad_snapshots
                    where session_id = :session_id
                    order by created_at asc
                    """
                ),
                {"session_id": session_id},
            )
            return [dict(row) for row in result.mappings().all()]

    return await asyncio.to_thread(_list)


async def export_session(session_id: str) -> Dict[str, Any]:
    session_row = await get_session(session_id)
    if not session_row:
        raise ValueError("session not found")
    agents = await list_agents(session_id)
    messages = await list_messages(session_id)
    notepad = await list_notepad_snapshots(session_id)
    return {
        "session": session_row,
        "agents": agents,
        "messages": messages,
        "notepad_snapshots": notepad,
        "rewards": [],
    }
