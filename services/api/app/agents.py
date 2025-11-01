from crewai import Agent, Task
from .llm import get_llm

# Lightweight, role-based agents with per-agent model_hint

def make_moderator(model_hint: str | None = None):
    llm_instance = get_llm(model_hint)
    return Agent(
        role="Moderator",
        goal=("Guide the team through Double Diamond phases; enforce timeboxing; "
              "write concise prompts and summaries; ask for confidence (0-1)."),
        backstory=("An experienced and neutral facilitator with a deep understanding of "
                   "conflict resolution and clear communication protocols."),
        verbose=True,
        llm=llm_instance,
    )

def make_participant(name: str, trait: str, model_hint: str | None = None):
    style = {
        "contrarian": "Challenge assumptions politely; propose alternatives with evidence.",
        "domain_expert": "Provide domain facts and constraints succinctly.",
        "risk_analyst": "Surface risks, failure modes, and mitigations.",
    }.get(trait, "Contribute concise, helpful reasoning.")
    backstory = {
        "contrarian": "Known for stress-testing ideas to ensure the strongest direction survives.",
        "domain_expert": "Practitioner who brings real-world constraints and best practices.",
        "risk_analyst": "Veteran risk analyst tasked with spotting hidden pitfalls early.",
    }.get(trait, "Collaborator invited for balanced, thoughtful contributions.")
    return Agent(role=name, goal=style, backstory=backstory, verbose=True, llm=get_llm(model_hint))

def make_notetaker(model_hint: str | None = None):
    return Agent(
        role="NoteTaker",
        goal=("Distill bullet points; extract decisions; end with TODO: lines; keep under 120 words."),
        backstory="Expert meeting scribe focused on capturing just the essentials.",
        verbose=False,
        llm=get_llm(model_hint),
    )

def simple_task(agent: Agent, input_text: str):
    return Task(
        description=input_text,
        agent=agent,
        expected_output="Return the single word 'ready' once you have processed the request.",
    )
