#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE_RELATIVE="infra/docker-compose.yml"
COMPOSE_FILE="$REPO_ROOT/$COMPOSE_FILE_RELATIVE"

echo "==> Checking API logs (last 120 lines)"
docker compose -f "$COMPOSE_FILE" logs api -n 120 || true

echo
echo "==> Checking Ollama logs (last 120 lines)"
docker compose -f "$COMPOSE_FILE" logs ollama -n 120 || true

echo
echo "==> Checking OLLAMA_URL inside api container"
docker compose -f "$COMPOSE_FILE" exec -T api env | grep -E '^OLLAMA_URL' || true

echo
echo "==> Running in-container probe reproduction"
docker compose -f "$COMPOSE_FILE" exec -T \
  -e DEBUG_AGENT_COMPOSE_FILE="$COMPOSE_FILE_RELATIVE" \
  api python - <<'PY'
import json
import traceback

import httpx
import inspect
import os
from crewai import Crew, Agent, Task
from crewai.llm import LLM
from app.agents import make_moderator, simple_task
from app.llm import OLLAMA_URL, DEFAULT_MODEL, LITELLM_ENV_KEYS

agent = make_moderator()
task = simple_task(agent, "Reply 'ready' if you can hear me.")

try:
    from importlib.metadata import version, PackageNotFoundError
    crewai_version = version("crewai")
except PackageNotFoundError:
    crewai_version = "unknown"

print("CrewAI version:", crewai_version)
print("OLLAMA_URL:", OLLAMA_URL)
print("DEFAULT_MODEL:", DEFAULT_MODEL)
for key in LITELLM_ENV_KEYS:
    print(f"{key} env:", os.environ.get(key))

try:
    with httpx.Client(timeout=5.0) as client:
        tags_resp = client.get(OLLAMA_URL.rstrip('/') + "/api/tags")
    print("GET /api/tags ->", tags_resp.status_code)
    print("Tags body (truncated):", tags_resp.text[:400])
    tags_json = None
    if tags_resp.headers.get("content-type", "").startswith("application/json"):
        try:
            tags_json = tags_resp.json()
        except ValueError:
            tags_json = None
    if tags_json is not None:
        models = []
        for entry in tags_json.get("models", []):
            if isinstance(entry, dict):
                for key in ("model", "name", "tag"):
                    value = entry.get(key)
                    if isinstance(value, str):
                        models.append(value)
        models = sorted(set(models))
        print("Discovered Ollama models:", models if models else "<none>")
        compose_file_hint = os.environ.get("DEBUG_AGENT_COMPOSE_FILE", "infra/docker-compose.yml")
        if not models:
            print(
                "No models are currently installed in the Ollama container. "
                f"Pull one (default '{DEFAULT_MODEL}') with:\n  docker compose -f {compose_file_hint} exec -T ollama "
                f"ollama pull {DEFAULT_MODEL}"
            )
        elif DEFAULT_MODEL not in models:
            print(
                f"Default model '{DEFAULT_MODEL}' is missing. "
                f"Install it via:\n  docker compose -f {compose_file_hint} exec -T ollama "
                f"ollama pull {DEFAULT_MODEL}\n"
                "Alternatively, set LLM_MODEL_ID to one of the installed models listed above."
            )
except Exception as tags_exc:
    print("Failed to reach Ollama /api/tags:", tags_exc)

if hasattr(agent.llm, "__dict__"):
    llm_public = {k: v for k, v in agent.llm.__dict__.items() if not k.startswith("_")}
    print("Agent LLM public attrs:", json.dumps(llm_public, indent=2, default=str))
else:
    print("Agent LLM value:", agent.llm)
print("Task expected_output:", task.expected_output)
print("LLM __init__ signature:", inspect.signature(LLM.__init__))
print("LLM call source:")
print(inspect.getsource(LLM.call))

try:
    crew = Crew(agents=[agent], tasks=[task])
    crew_llm = crew.agents[0].llm
    print("Crew agent LLM type:", type(crew_llm))
    if hasattr(crew_llm, "__dict__"):
        print("Crew agent LLM model attr:", getattr(crew_llm, "model", None))
    else:
        print("Crew agent LLM value:", crew_llm)
    result = crew.kickoff()
    print("Task result type:", type(result))
    print("Task result:", result)
except Exception:
    print("Task execution raised:")
    traceback.print_exc()
PY
