# CrewTalk – Codex Onboarding Notes

## Stack At A Glance
- **API**: `services/api` (FastAPI 0.115, Python 3.11) backed by CrewAI 0.60.0 and LiteLLM.
- **Web UI**: Next.js app in `apps/web` (talks to the API via `NEXT_PUBLIC_API_URL`).
- **Infra**: Docker Compose stack under `infra/docker-compose.yml` (services: `api`, `web`, `ollama`, `db`).
- **Models**: Ollama-served Gemma (`gemma3:4b-it-qat` by default, configurable via `LLM_MODEL_ID`).

## LLM Integration
- `services/api/app/llm.py`: `get_llm()` returns the provider string `ollama/<model>` and force-syncs Ollama-related env vars (`LITELLM_OLLAMA_API_BASE`, `OLLAMA_BASE_URL`, `OLLAMA_HOST`, `OLLAMA_URL`, `OLLAMA_API_BASE`) to the URL in `.env` (default `http://ollama:11434`). CrewAI then instantiates its own wrapper without double-wrapping.
- **Critical**: Inside the API container the Ollama endpoint is *not* `localhost`. If LiteLLM logs still show `localhost:11434`, re-check these env vars or restart the container. If you are running Ollama on the host, set `OLLAMA_URL=http://host.docker.internal:11434`.
- The Ollama container now pulls `${LLM_MODEL_ID}` automatically during startup.  
  Run `docker compose -f infra/docker-compose.yml exec -T ollama ollama pull <other-model>` only when switching to a different tag.

## Agent Templates
- `services/api/app/agents.py` defines `make_moderator`, `make_participant`, `make_notetaker`, ensuring CrewAI-required fields:
  - `backstory` is mandatory (missing it triggers a `ValidationError`).
  - `simple_task()` must include `expected_output` or CrewAI raises validation errors.

## Session Flow
- Metadata lives in Postgres (`sessions`, `agents`, `messages`, `notepad_snapshots`). Short-term context (per-agent scratch + notepad) resides in Redis.
- `POST /sessions` inserts a new session row (`status=idle`, `phase=discover`).
- `POST /sessions/{sid}/agents` runs a one-turn “ready” probe and persists the agent.
- `POST /sessions/{sid}/start` spins up a `SessionEngine` (one per session) that:
  - orchestrates Double Diamond phases with deterministic Moderator → Participants → NoteTaker turns,
  - streams LiteLLM deltas (`token.delta`) to `/sessions/{sid}/stream`,
  - commits telemetry-enhanced `message.created` entries to Postgres,
  - maintains short-term memory (last 8 turns per agent) in Redis, and
  - handles pause/resume/advance/stop controls.
- `GET /sessions/{sid}` hydrates the UI (agents, last 50 messages, notepad).
- `GET /sessions/{sid}/export` returns full session/agent/message/notepad history.

## Known Issues & Fixes
1. **LiteLLM “LLM object has no attribute split”**  
   - Cause: wrapping CrewAI’s `LLM` manually or returning a dict from `get_llm()`.  
   - Fix: return the plain provider string as noted above.
2. **502 Probe Failures**  
   - Usual causes: model not pulled yet, Ollama env vars pointing at `localhost`, or Ollama offline.  
   - Use `scripts/debug_agent_probe.sh` to collect logs + run an in-container probe.
3. **Agent creation 500s**  
   - Missing `backstory` or `expected_output` → ensure `services/api/app/agents.py` helpers are used.
4. **Ollama model list empty**  
   - `GET /api/tags` returning `{"models":[]}` is expected before a pull; completions will fail until a model is downloaded.

## Helpful Scripts
- `scripts/debug_agent_probe.sh`: Tails `api`/`ollama` logs, prints relevant env vars, and runs the Crew probe directly inside the API container.
- `scripts/inspect_llm_signature.sh`: Snapshot of CrewAI `LLM` signature/implementation (helps verify upstream changes).
- `scripts/test_ollama_connectivity.sh`: Existing sanity script referenced in README.

## Bring-Up Checklist
1. `cd infra && docker compose up --build`
2. Confirm `curl http://localhost:8080/health/ollama` returns `{"ok": true, …}`
3. Add moderator + participants via UI (each runs the readiness probe).
4. Start the session; watch `/sessions/{sid}/stream` (UI handles WebSocket subscriptions).
5. Optional: pull alternate models with `docker compose exec -T ollama ollama pull <model>`

## References
- Root `README.md` for prerequisites, initial workflow, and configuration knobs.
- `services/api/app/main.py` for endpoint contracts and probe logic.
