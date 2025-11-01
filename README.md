# CrewTalk Bootstrap (FastAPI + CrewAI + Next.js)

## Prereqs
- Docker & Docker Compose
- Enough disk space for Ollama model downloads (the default Gemma build is ~3.2 GB on disk)

## First run
```bash
# 1) Start the stack
cd infra
docker compose up --build

# 2) Pull the default model inside the Ollama container
docker compose exec ollama ollama pull gemma3:4b-it-qat
#   (use `gemma3:4b` if you prefer the full-precision build)

# 3) Verify the API sees Ollama
curl -s http://localhost:8080/health/ollama | jq
# UI: http://localhost:3000
```

## Key settings
- `OLLAMA_URL` defaults to `http://ollama:11434` in `.env.example`, targeting the bundled container.
- Change the default model via `LLM_MODEL_ID` (e.g. `LLM_MODEL_ID=gemma3:4b`).
- Client code (web) continues to talk to the API through `NEXT_PUBLIC_API_URL=http://localhost:8080`.
- `CORS_ORIGIN` is `*` by default for local work; set a comma-separated allowlist before deploying.

## Troubleshooting
- If `/health/ollama` fails, ensure the Ollama container is running (`docker compose ps ollama`) and that the model is pulled.
- The helper script `scripts/test_ollama_connectivity.sh` checks both host and in-container access paths.
- When switching models, update both `LLM_MODEL_ID` and rerun the `ollama pull` command inside the container.
