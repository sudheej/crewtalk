import os
from crewai.llm import LLM

# If Ollama runs on the *host*, containers must use host.docker.internal
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://host.docker.internal:11434")
DEFAULT_MODEL = os.getenv("LLM_MODEL_ID", "gemma3:4b-it-qat")

def get_llm(model_hint: str | None = None) -> LLM:
    model = model_hint or DEFAULT_MODEL
    return LLM(
        model=f"ollama/{model}",   # LiteLLM route (provider/model)
        base_url=OLLAMA_URL,
        temperature=0.2,
    )
