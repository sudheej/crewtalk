#!/usr/bin/env bash
set -euo pipefail

# Verifies the Ollama API from both the host and the FastAPI container.
# Usage: scripts/test_ollama_connectivity.sh [host_base_url] [container_base_url]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.yml"
HOST_OLLAMA_BASE="${1:-http://127.0.0.1:11434}"
CONTAINER_OLLAMA_BASE="${2:-http://ollama:11434}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required on the host to run this script." >&2
  exit 1
fi

echo "== Host check: ${HOST_OLLAMA_BASE}/api/tags =="
if HOST_RESPONSE="$(curl -fsS "${HOST_OLLAMA_BASE}/api/tags")"; then
  echo "Host reachable. Response:"
  echo "${HOST_RESPONSE}"
else
  STATUS=$?
  echo "Host check failed (curl exit ${STATUS})." >&2
  exit ${STATUS}
fi

if [ ! -f "${COMPOSE_FILE}" ]; then
  echo "docker-compose file not found at ${COMPOSE_FILE}." >&2
  exit 1
fi

if ! docker compose -f "${COMPOSE_FILE}" ps api >/dev/null 2>&1; then
  echo "API container is not running; start it with 'docker compose up' before testing." >&2
  exit 1
fi

echo ""
echo "== Container check (api): ${CONTAINER_OLLAMA_BASE}/api/tags =="
docker compose -f "${COMPOSE_FILE}" exec -T api env OLLAMA_CONNECT_TEST_OVERRIDE="${CONTAINER_OLLAMA_BASE}" python - <<'PY'
import json
import os
import sys

import httpx

base = os.environ.get("OLLAMA_URL", "http://ollama:11434")
override = os.environ.get("OLLAMA_CONNECT_TEST_OVERRIDE")
if override:
    base = override
url = base.rstrip("/") + "/api/tags"

try:
    resp = httpx.get(url, timeout=5.0)
except Exception as exc:  # pragma: no cover
    print(f"ERROR: request failed -> {exc}", file=sys.stderr)
    sys.exit(2)

print(f"Status: {resp.status_code}")
if resp.headers.get("content-type", "").startswith("application/json"):
    print(json.dumps(resp.json()))
else:
    print(resp.text)

sys.exit(0 if resp.status_code == 200 else 3)
PY
