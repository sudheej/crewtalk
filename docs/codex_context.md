# CrewTalk – Codex Onboarding Notes

## Stack At A Glance
- **API**: `services/api` (FastAPI 0.115, Python 3.11) backed by CrewAI 0.60.0 and LiteLLM.
- **Web UI**: Next.js app in `apps/web` (talks to the API via `NEXT_PUBLIC_API_URL`).
- **Infra**: Docker Compose stack under `infra/docker-compose.yml` (services: `api`, `web`, `ollama`, `db`).
- **Models**: Ollama-served Gemma (`gemma3:4b-it-qat` by default, configurable via `LLM_MODEL_ID`).

## LLM Integration
- `services/api/app/llm.py`: `get_llm()` returns the provider string `ollama/<model>` and force-syncs Ollama-related env vars (`LITELLM_OLLAMA_API_BASE`, `OLLAMA_BASE_URL`, `OLLAMA_HOST`, `OLLAMA_URL`, `OLLAMA_API_BASE`) to `http://ollama:11434`. CrewAI then instantiates its own wrapper without double-wrapping.
- **Critical**: Inside the API container the Ollama endpoint is *not* `localhost`. If LiteLLM logs still show `localhost:11434`, re-check these env vars or restart the container.
- Pull the target model *inside* the Ollama container after boot:  
  `docker compose -f infra/docker-compose.yml exec -T ollama ollama pull gemma3:4b-it-qat`

## Agent Templates
- `services/api/app/agents.py` defines `make_moderator`, `make_participant`, `make_notetaker`, ensuring CrewAI-required fields:
  - `backstory` is mandatory (missing it triggers a `ValidationError`).
  - `simple_task()` must include `expected_output` or CrewAI raises validation errors.

## Session Flow
- `POST /sessions` seeds in-memory metadata (`SESSIONS` dict).
- `POST /sessions/{sid}/agents` builds the requested agent, stores its spec, and runs a 1-turn probe (`Crew(...).kickoff()`) expecting the agent to return `ready`. Any failure bubbles up as `HTTP 502 Agent probe failed: …`.
- `GET /health/ollama` proxies a `/api/tags` call to confirm the API container can reach Ollama.

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
2. `docker compose exec -T ollama ollama pull <model>` (default `gemma3:4b-it-qat`)
3. Confirm `curl http://localhost:8080/health/ollama` returns `{"ok": true, …}`
4. Optional: `./scripts/debug_agent_probe.sh` to validate the probe task.

## References
- Root `README.md` for prerequisites, initial workflow, and configuration knobs.
- `services/api/app/main.py` for endpoint contracts and probe logic.
