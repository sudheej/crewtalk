from __future__ import annotations

from typing import AsyncIterator, Dict, List, Optional

import litellm


async def stream_chat(
    model: str,
    messages: List[Dict[str, str]],
    *,
    base_url: Optional[str] = None,
    temperature: float = 0.2,
    stop: Optional[List[str]] = None,
) -> AsyncIterator[str]:
    """Stream text deltas from LiteLLM."""

    kwargs: Dict[str, object] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }
    if stop:
        kwargs["stop"] = stop
    if base_url:
        kwargs["base_url"] = base_url

    stream = await litellm.acompletion(**kwargs)
    async for chunk in stream:
        if not chunk:
            continue
        choices = chunk.get("choices")
        if not choices:
            continue
        delta = choices[0].get("delta") or {}
        text_delta = delta.get("content")
        if text_delta:
            yield text_delta
