#!/bin/sh
set -eu

MODEL="${LLM_MODEL_ID:-gemma3:4b-it-qat}"

ensure_model() {
  temp_pid=""
  echo "[ollama-entrypoint] Bootstrapping temporary server to manage models..."
  /bin/ollama serve >/tmp/ollama-bootstrap.log 2>&1 &
  temp_pid=$!

  wait_attempt=1
  server_ready=0
  until ollama list >/dev/null 2>&1; do
    if [ "$wait_attempt" -ge 15 ]; then
      echo "[ollama-entrypoint] WARNING: Ollama server did not become ready in time" >&2
      break
    fi
    sleep 1
    wait_attempt=$((wait_attempt + 1))
  done
  if [ "$wait_attempt" -lt 15 ]; then
    server_ready=1
  fi

  if [ "$server_ready" -eq 1 ] && [ -n "$MODEL" ]; then
    echo "[ollama-entrypoint] Ensuring model '${MODEL}' is available..."
    if ! ollama show "${MODEL}" >/dev/null 2>&1; then
      if ! ollama pull "${MODEL}"; then
        echo "[ollama-entrypoint] WARNING: failed to pull model '${MODEL}'" >&2
      fi
    else
      echo "[ollama-entrypoint] Model '${MODEL}' already present."
    fi
  elif [ "$server_ready" -ne 1 ]; then
    echo "[ollama-entrypoint] WARNING: skipping model pull because the bootstrap server was not ready. See /tmp/ollama-bootstrap.log" >&2
  fi

  if [ -n "$temp_pid" ]; then
    kill "$temp_pid" 2>/dev/null || true
    wait "$temp_pid" 2>/dev/null || true
  fi
}

if [ -n "$MODEL" ]; then
  ensure_model
fi

echo "[ollama-entrypoint] Starting ollama serve"
exec /bin/ollama serve
