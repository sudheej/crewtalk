import sys
import types
import unittest

_dummy_asyncio = types.SimpleNamespace(from_url=lambda *args, **kwargs: None)
sys.modules.setdefault("redis", types.SimpleNamespace(asyncio=_dummy_asyncio))
sys.modules.setdefault("redis.asyncio", _dummy_asyncio)

_dummy_sqlalchemy = types.ModuleType("sqlalchemy")
_dummy_sqlalchemy.text = lambda value: value
_dummy_sqlalchemy.create_engine = lambda *args, **kwargs: object()
_dummy_sqlalchemy.orm = types.SimpleNamespace(sessionmaker=lambda **kwargs: lambda *args, **kw: None)
sys.modules.setdefault("sqlalchemy", _dummy_sqlalchemy)
sys.modules.setdefault("sqlalchemy.orm", _dummy_sqlalchemy.orm)


async def _dummy_acompletion(**kwargs):
    async def _generator():
        if False:  # pragma: no cover
            yield None

    return _generator()


sys.modules.setdefault("litellm", types.SimpleNamespace(acompletion=_dummy_acompletion))

from services.api.app.engine.session_engine import SessionEngine
from services.api.app.engine.strategy.double_diamond import DoubleDiamondPhase


class SessionEnginePromptTests(unittest.TestCase):
    def test_prompt_includes_problem_statement(self) -> None:
        engine = SessionEngine("session-1")
        engine._session_meta = {"problem_statement": "Increase marketplace retention among new sellers."}

        agent = {"id": "agent-1", "name": "Alex", "role": "moderator"}
        phase = DoubleDiamondPhase(name="discover", duration_sec=300, objective="Explore assumptions")

        prompt = engine._build_prompt(
            agent=agent,
            phase=phase,
            memories=[],
            notepad="",
            notepad_mode=False,
            summary_mode=False,
        )

        self.assertIn("Problem statement:", prompt)
        self.assertIn("Increase marketplace retention among new sellers.", prompt)


if __name__ == "__main__":
    unittest.main()
