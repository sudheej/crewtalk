import os

# Default to the docker service; override via OLLAMA_URL env if needed
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://ollama:11434")
DEFAULT_MODEL = os.getenv("LLM_MODEL_ID", "gemma3:4b-it-qat")

LITELLM_ENV_KEYS = [
    "LITELLM_OLLAMA_API_BASE",
    "OLLAMA_BASE_URL",
    "OLLAMA_HOST",
    "OLLAMA_URL",
    "OLLAMA_API_BASE",
]

# Ensure Ollama-related environment variables are set as soon as this module is imported
for env_key in LITELLM_ENV_KEYS:
    os.environ.setdefault(env_key, OLLAMA_URL)


def get_llm(model_hint: str | None = None) -> str:
    """
    CrewAI 0.60 expects the `llm` passed to Agent(...) to be either a provider string
    or an LLM instance. Returning the provider string keeps us aligned with the
    built-in CrewAI wrapper while the environment variables steer LiteLLM.
    """
    model = model_hint or DEFAULT_MODEL

    # Keep environment values fresh at call-time in case they were modified elsewhere.
    for env_key in LITELLM_ENV_KEYS:
        os.environ[env_key] = OLLAMA_URL

    return f"ollama/{model}"
