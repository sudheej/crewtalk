# CrewTalk Bootstrap (FastAPI + CrewAI + Next.js)

## Prereqs
- Docker & Docker Compose
- Enough disk space for Ollama model downloads (the default Gemma build is ~3.2 GB on disk)

## First run
```bash
# 1) Start the stack
cd infra
docker compose up --build

# 2) (Optional) Pull a different model inside the Ollama container
#     The Ollama service now pulls `${LLM_MODEL_ID}` automatically on startup.
docker compose exec ollama ollama pull gemma3:4b-it-qat
#   (use `LLM_MODEL_ID=gemma3:4b` for the full-precision build, or pull another tag)

# 3) Verify the API sees Ollama
curl -s http://localhost:8080/health/ollama | jq
# UI: http://localhost:3000
```

## Key settings
- `OLLAMA_URL` defaults to `http://ollama:11434` in `.env.example`, targeting the bundled container. Override this if you prefer to run Ollama directly on the host (e.g. `OLLAMA_URL=http://host.docker.internal:11434` on Docker Desktop).
- Change the default model via `LLM_MODEL_ID` (e.g. `LLM_MODEL_ID=gemma3:4b`).
- Client code (web) continues to talk to the API through `NEXT_PUBLIC_API_URL=http://localhost:8080`.
- `CORS_ORIGIN` is `*` by default for local work; set a comma-separated allowlist before deploying.

## Session orchestration (Double Diamond)
1. Create a session from the web UI (title, problem statement, time limit/strategy).
2. Add agents (moderator, ≥1 participant, optional note-taker). Each agent runs a one-turn “ready” probe before being persisted.
3. Click `Start Session` to launch the async engine. The backend streams `token.delta` events over WebSocket while each agent speaks; the UI displays live drafts and commits the final `message.created`.
4. Use `Pause`, `Resume`, `Advance Phase`, and `Stop` controls as needed. Phase changes trigger moderator summaries and update the countdown.
5. Collaborators can edit the shared notepad; changes persist to Postgres/Redis and broadcast via `notepad.updated`.
6. Refreshing the page calls `GET /sessions/{id}` to rebuild the latest 50 turns, agent roster, and notepad snapshot.

The engine stores every committed message with sentiment/confidence scores, while short-term context (last 8 turns per agent) and the notepad live in Redis. Export a full transcript via `GET /sessions/{id}/export`.

### API quick reference
- `POST /sessions` → create a session (`status=idle`, `phase=discover`).
- `POST /sessions/{sid}/agents` → add an agent after running the probe.
- `POST /sessions/{sid}/start|pause|resume|advance|stop` → control the orchestrator.
- `POST /sessions/{sid}/notepad` → persist the shared notepad.
- `GET /sessions/{sid}` → hydrate the UI (agents, recent turns, notepad).
- `GET /sessions/{sid}/export` → download full session history.
- `GET /sessions/{sid}/stream` → WebSocket delivering `session.status`, `phase.changed`, `token.delta`, `message.created`, `notepad.updated`, and `error` events.

## Troubleshooting
- If `/health/ollama` fails, ensure the Ollama container is running (`docker compose ps ollama`) and that the model is pulled.
- The helper script `scripts/test_ollama_connectivity.sh` checks both host and in-container access paths.
- When switching models, update both `LLM_MODEL_ID` and rerun the `ollama pull` command inside the container.
- If streaming stalls, confirm the WebSocket (`/sessions/{id}/stream`) is reachable and that the engine status is `running` (check the UI run log for `session.status` events).
