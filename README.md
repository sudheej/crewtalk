# CrewTalk 

CrewTalk is a collaborative workshop simulator that uses CrewAI agents to run time-boxed ideation sessions. The stack bundles a FastAPI backend, a Next.js control room UI, and an Ollama-hosted Gemma model so you can experiment with multi-agent facilitation, sentiment tracking, and Double Diamond workflows end-to-end.

## Highlights
- **Multi-agent orchestration** – Moderator, participant, and note-taker roles collaborate through CrewAI with per-agent model overrides.
- **Real-time collaboration** – The API streams token deltas, status, and notepad updates over WebSockets so the UI can show live drafts and transcripts.
- **Batteries-included infra** – Docker Compose brings up FastAPI, Next.js, Postgres, Redis, and Ollama with a bootstrap script that auto-pulls the configured model.
- **Persistent telemetry** – Messages land in Postgres with sentiment/confidence scores, while Redis tracks short-term context and the shared notepad.

## Architecture At A Glance
```
+-------------+      WebSocket / REST       +-------------------+
| Next.js UI  | <-------------------------> | FastAPI Orchestrator|
| apps/web    |                             | services/api        |
+-------------+                             +--------------------+
        |                                              |
        | REST / SDK                                   | async LLM streams
        v                                              v
+----------------+     pgcrypto UUIDs     +------------------+
| Postgres (db)  | <--------------------> | Session Engine    |
+----------------+                        | crew sessions     |
        ^                                              |
        |                                              v
        | redis pub/sub + notepad cache     +------------------+
        +----------------------------------> | Redis (scratch) |
                                              +------------------+
                                              |
                                              v
                                   +--------------------------+
                                   | Ollama (Gemma models)    |
                                   +--------------------------+
```

## Repository Layout
```
apps/web            # Next.js UI (pixel retro control panel)
services/api        # FastAPI + CrewAI session engine
infra               # docker-compose stack, Ollama bootstrap script
scripts             # Helper scripts for debugging LLM connectivity and probes
docs                # Additional onboarding/context notes
volumes             # Data directories mounted by Docker Compose
```

## Prerequisites
- Docker & Docker Compose
- Disk space for Ollama models (Gemma 3 4B QAT ≈ 3.2 GB; full-precision builds are larger)
- `jq` (optional but handy for pretty-printing health checks)

## Quick Start (Docker Compose)
```bash
# 1. Copy environment defaults if needed
cp .env.example .env  # edit if you want to point at a host-managed Ollama

# 2. Launch the stack
cd infra
docker compose up --build

# 3. Visit the apps
# API:     http://localhost:8080
# Web UI:  http://localhost:3000

# 4. Confirm the API sees Ollama
curl -s http://localhost:8080/health/ollama | jq

# 5. (Optional) Pull a different model inside the Ollama container
docker compose exec ollama ollama pull gemma3:4b
```

The Ollama service automatically pulls `${LLM_MODEL_ID}` during startup (`gemma3:4b-it-qat` by default). Use the exec command above to install additional tags.

## Core Concepts
- **Sessions** – Created via `POST /sessions` or the UI, each tracks title, problem statement, total time budget, strategy, and current phase.
- **Agents** – Moderators, participants, and an optional note-taker; each runs a readiness probe (CrewAI kickoff returning “ready”) before being persisted.
- **Double Diamond strategy** – Four phases (`discover`, `define`, `develop`, `deliver`) time-sliced across the session; prompts are tuned per phase (`services/api/app/engine/strategy/double_diamond.py`).
- **Streaming engine** – `SessionEngine` rotates through moderator → participants → note-taker turns, streams `token.delta` events during generation, and flushes the final `message.created` to Postgres with sentiment/confidence heuristics.
- **Shared notepad** – Lives in Redis for low-latency collaboration and is periodically snapshotted to Postgres for exports.

## Operating A Session (UI Flow)
1. Create a session (title, problem statement, time limit, strategy) from the home panel.
2. Add at least one moderator and participant. Traits (contrarian, domain expert, risk analyst) adjust the agent’s goal/backstory; `model_hint` overrides the default LLM.
3. Start the session. The backend begins streaming live updates to the UI log, transcript, and notepad.
4. Use **Pause**, **Resume**, **Advance Phase**, and **Stop** controls as needed. Phase transitions trigger moderator summaries and update the countdown timers.
5. Export transcripts via the **Export** button (`GET /sessions/{id}/export`) for a full history including notepad snapshots.

## Key Settings & Environment
- `OLLAMA_URL` defaults to `http://ollama:11434` (container-to-container). Set it to `http://host.docker.internal:11434` to reuse a host-managed Ollama instance.
- `LLM_MODEL_ID` controls the CrewAI provider string (e.g. `gemma3:4b`) – update both the environment variable and pull the model.
- `NEXT_PUBLIC_API_URL` tells the web app where to find the API (defaults to `http://localhost:8080`).
- `CORS_ORIGIN` accepts a comma-separated allowlist; it defaults to `*` for local development.
- Database connection info (`DATABASE_URL`) and Redis URL (`REDIS_URL`) live in `.env.example`; `init_db()` applies migrations + pgcrypto.

## API Quick Reference
- `GET /health/ollama` – Verify the backend can reach Ollama’s `/api/tags`.
- `POST /sessions` – Create a session (`status=idle`, `phase=discover`).
- `POST /sessions/{sid}/agents` – Add an agent after running the readiness probe.
- `POST /sessions/{sid}/start|pause|resume|advance|stop` – Orchestrate the engine lifecycle.
- `POST /sessions/{sid}/notepad` – Persist and broadcast notepad changes.
- `GET /sessions/{sid}` – Hydrate the UI (agents, latest 50 turns, notepad snapshot).
- `GET /sessions/{sid}/export` – Download the full session package (agents, messages, notepad timeline).
- `GET /sessions/{sid}/stream` – WebSocket delivering `session.status`, `phase.changed`, `token.delta`, `message.created`, `notepad.updated`, and `error` events.

## Local Development (without full Compose)
You can run services independently if you already have Postgres, Redis, and Ollama running.

### Backend (FastAPI)
```bash
# Ensure DATABASE_URL, REDIS_URL, OLLAMA_URL, and LLM_MODEL_ID are set
cd services/api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

### Frontend (Next.js)
```bash
cd apps/web
npm install
NEXT_PUBLIC_API_URL=http://localhost:8080 npm run dev
```

If you are not using Docker for the data stores, update `.env` to point at your Postgres, Redis, and Ollama instances before starting the API.

## Helper Scripts
- `scripts/test_ollama_connectivity.sh` – Checks host and in-container connectivity to Ollama and highlights common misconfigurations.
- `scripts/debug_agent_probe.sh` – Collects `api`/`ollama` logs and replays the CrewAI readiness probe inside the API container.
- `scripts/inspect_llm_signature.sh` – Dumps CrewAI `LLM` signatures to spot upstream changes that might break agent creation.

## Troubleshooting
- `/health/ollama` fails – Ensure the Ollama container is running (`docker compose ps ollama`) and the desired model has been pulled.
- Agent probe 502s – Missing backstory/expected output or the LLM URL points to `localhost`; use `scripts/debug_agent_probe.sh` to reproduce inside the container.
- Empty streaming transcript – Verify the WebSocket (`/sessions/{id}/stream`) is reachable and the engine status is `running`. The UI activity log shows `session.status` transitions.
- Switching models – Update `LLM_MODEL_ID`, restart the `api` service (to pick up env vars), and pull the new tag via `docker compose exec ollama ollama pull <model>`.
- Postgres errors about `gen_random_uuid` – Confirm the `pgcrypto` extension is enabled; `init_db()` handles it automatically on startup.
