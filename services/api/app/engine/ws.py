import asyncio
import time
from collections import defaultdict
from typing import Any, Dict, Set


class SessionBroadcaster:
    """Manages per-session event queues for WebSocket consumers."""

    def __init__(self) -> None:
        self._listeners: Dict[str, Set[asyncio.Queue]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def register(self, session_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        async with self._lock:
            self._listeners[session_id].add(queue)
        return queue

    async def unregister(self, session_id: str, queue: asyncio.Queue) -> None:
        async with self._lock:
            listeners = self._listeners.get(session_id)
            if not listeners:
                return
            listeners.discard(queue)
            if not listeners:
                self._listeners.pop(session_id, None)

    async def emit(self, session_id: str, event_type: str, payload: Dict[str, Any]) -> None:
        listeners: Set[asyncio.Queue]
        async with self._lock:
            listeners = set(self._listeners.get(session_id, set()))

        if not listeners:
            return

        message = {
            "session_id": session_id,
            "event": event_type,
            "payload": payload,
            "ts": time.time(),
        }

        for queue in listeners:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # drop oldest to make room
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(message)
                except asyncio.QueueFull:
                    # still full; skip this listener
                    continue

    async def close_session(self, session_id: str) -> None:
        async with self._lock:
            listeners = self._listeners.pop(session_id, set())
        for queue in listeners:
            queue.put_nowait({"event": "session.closed", "session_id": session_id, "payload": {}})


session_broadcaster = SessionBroadcaster()
