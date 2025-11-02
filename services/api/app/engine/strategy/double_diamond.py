from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class DoubleDiamondPhase:
    name: str
    duration_sec: int
    objective: str


PHASE_ORDER = [
    ("discover", "Explore the problem space, gather insights, and surface open questions."),
    ("define", "Synthesize findings into a clear problem statement and prioritize needs."),
    ("develop", "Generate solution concepts, stress test options, and refine promising ideas."),
    ("deliver", "Select a direction, outline execution steps, and call out success metrics."),
]


def get_phases(total_time_sec: int) -> List[DoubleDiamondPhase]:
    total = max(total_time_sec, 120)
    base = total // len(PHASE_ORDER)
    remainder = total % len(PHASE_ORDER)
    phases: List[DoubleDiamondPhase] = []
    for idx, (name, objective) in enumerate(PHASE_ORDER):
        duration = base + (1 if idx < remainder else 0)
        phases.append(DoubleDiamondPhase(name=name, duration_sec=duration, objective=objective))
    return phases


def phase_prompt(phase_name: str) -> str:
    prompts = {
        "discover": (
            "You are facilitating the DISCOVER phase. Focus on gathering observations, "
            "user pains, and unmet needs. Encourage clarifying questions and avoid jumping "
            "to solutions yet."
        ),
        "define": (
            "You are in the DEFINE phase. Summarize insights, frame the problem crisply, "
            "and push the team toward a shared articulation of the target outcome."
        ),
        "develop": (
            "You are in the DEVELOP phase. Brainstorm solution approaches, compare trade-offs, "
            "and combine ideas into stronger directions. Keep responses concise and purposeful."
        ),
        "deliver": (
            "You are in the DELIVER phase. Converge on an actionable plan, outline next steps, "
            "and highlight metrics or validation steps. End with any risks or asks."
        ),
    }
    return prompts.get(
        phase_name,
        "Drive the conversation forward with clarity and focus. Respond succinctly.",
    )
