#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.yml"

docker compose -f "$COMPOSE_FILE" exec -T api python - <<'PY'
import inspect
from crewai.llm import LLM
from crewai import Agent

print("LLM __init__ signature:")
print(inspect.signature(LLM.__init__))

print("\nLLM attributes:", [attr for attr in dir(LLM) if not attr.startswith("_")])

try:
    print("\nLLM.call source:")
    import textwrap
    source = inspect.getsource(LLM.call)
    print(textwrap.dedent(source))
except OSError as exc:
    print("\nUnable to read LLM.call source:", exc)

print("\nAgent __init__ signature:")
print(inspect.signature(Agent.__init__))
try:
    print("\nAgent __init__ source snippet:")
    import textwrap
    source = inspect.getsource(Agent.__init__)
    print(textwrap.dedent(source))
except OSError as exc:
    print("Unable to read Agent.__init__ source:", exc)
PY
