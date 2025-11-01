from crewai import Agent, Task
from .llm import get_llm

# Lightweight, role-based agents with per-agent model_hint

def make_moderator(model_hint: str | None = None):
    return Agent(
        role="Moderator",
        goal=("Guide the team through Double Diamond phases; enforce timeboxing; "
              "write concise prompts and summaries; ask for confidence (0-1)."),
        verbose=True,
        llm=get_llm(model_hint),
    )

def make_participant(name: str, trait: str, model_hint: str | None = None):
    style = {
        "contrarian": "Challenge assumptions politely; propose alternatives with evidence.",
        "domain_expert": "Provide domain facts and constraints succinctly.",
        "risk_analyst": "Surface risks, failure modes, and mitigations.",
    }.get(trait, "Contribute concise, helpful reasoning.")
    return Agent(role=name, goal=style, verbose=True, llm=get_llm(model_hint))

def make_notetaker(model_hint: str | None = None):
    return Agent(
        role="NoteTaker",
        goal=("Distill bullet points; extract decisions; end with TODO: lines; keep under 120 words."),
        verbose=False,
        llm=get_llm(model_hint),
    )

def simple_task(agent: Agent, input_text: str):
    return Task(description=input_text, agent=agent)
