"""Typed messages between the four Ad Lab agents, and the five role-based protocols.

uagents Models are pydantic v1 (uagents_core/models.py), so fields use list[...] and
`X | None`, and no field is named json, dict, schema or copy. Every user-originated message
carries request_id so Ad Lab can route the reply to the right ASI:One conversation; everything
inside a run also carries run_id.

Roles list each agent's *incoming* models. Protocol(spec=..., role=...) registers only those,
verify() requires a handler for each, and senders don't register what they only send.
"""

from __future__ import annotations

from uagents_core.models import Model
from uagents_core.protocol import ProtocolSpecification

PROTO_VERSION = "0.1.0"


# --- intel (Ad Lab <-> Scout) ---------------------------------------------------------------


class VoiceItem(Model):
    label: str
    quote: str = ""
    frequency: int = 0
    platforms: list[str] = []


class Persona(Model):
    segment_id: str
    name: str
    share: float = 0.0


class BrandProfile(Model):
    name: str = "Magic Spoon"
    positioning: str = ""
    proof_points: list[str] = []
    pains: list[VoiceItem] = []
    desires: list[VoiceItem] = []
    objections: list[VoiceItem] = []
    personas: list[Persona] = []


class CompetitorStat(Model):
    name: str
    ads: int = 0
    winners: int = 0


class CompetitorAd(Model):
    brand: str
    angle: str = ""
    hook: str = ""
    headline: str = ""
    days_running: int = 0
    image_url: str = ""
    creative_id: str = ""


class Pattern(Model):
    concept: str
    share: float = 0.0


class CompetitorIntel(Model):
    competitors: list[CompetitorStat] = []
    winners: list[CompetitorAd] = []
    patterns: list[Pattern] = []


class RefreshPick(Model):
    kind: str  # page | source
    target: str
    actor: str = ""
    job_type: str = ""
    ref_id: str
    last_synced_at: str | None = None
    reason: str = ""


class RefreshJob(Model):
    job_id: str
    target: str = ""
    actor: str = ""
    status: str = ""
    dry: bool = True


class IntelRequest(Model):
    request_id: str
    goal: str
    # The brand kit Ad Lab checked before starting (GET /brand-kit): the site and the product photo.
    brand_url: str = ""
    brand_name: str = ""
    product_photo: bool = False
    refresh: bool = True
    max_pages: int = 2
    max_sources: int = 2


class IntelReport(Model):
    request_id: str
    mode: str = "test"
    dry: bool = True
    picks: list[RefreshPick] = []
    jobs: list[RefreshJob] = []
    brand: BrandProfile
    competitors: CompetitorIntel
    note: str = ""


# --- progress (any agent -> Ad Lab) ---------------------------------------------------------


class Progress(Model):
    request_id: str = ""
    run_id: str = ""
    source: str
    stage: str
    text: str
    level: str = "info"  # info | warn | error


# --- plan (Ad Lab <-> Strategist) -----------------------------------------------------------


class RecipeItem(Model):
    arm_id: str
    strategy: str = ""
    angle: str = ""
    hook: str = ""
    rationale: str = ""


class PlanRequest(Model):
    request_id: str
    goal: str = ""
    rounds_hint: int | None = None


class RecipePlan(Model):
    request_id: str
    plan_id: str
    run_id: str
    rounds_planned: int
    population: int = 300
    seed: int = 13
    recipes: list[RecipeItem] = []
    segments: list[Persona] = []
    check_ok: bool = False
    check_failures: list[str] = []
    round0_complete: bool = False
    round0_expected: int = 0
    round0_ranked: int = 0
    db_name: str = ""
    is_local: bool = False
    mode: str = "test"
    runs_allowed: bool = False
    blocked_reason: str = ""
    rationale: str = ""


# --- run (Ad Lab -> Strategist -> Ad Lab + Copywriter) --------------------------------------


class StartRun(Model):
    request_id: str
    plan_id: str
    run_id: str
    rounds_planned: int
    requested_by: str = "user"


class RunStarted(Model):
    request_id: str
    run_id: str
    task_id: str
    rounds_planned: int
    db_name: str = ""


class LeaderEntry(Model):
    arm_id: str
    recipe: str = ""
    strategy: str = ""
    p_best: float = 0.0
    cpo_usd: float | None = None
    share: float = 0.0


class LeaderRow(Model):
    segment_id: str
    segment_name: str = ""
    impressions: int = 0
    top: list[LeaderEntry] = []
    control: LeaderEntry | None = None


class LearningNote(Model):
    learning_id: str
    segment_id: str = ""
    segment_name: str = ""
    arm_id: str | None = None
    kind: str = ""
    statement: str = ""


class WinnerNote(Model):
    segment_id: str
    segment_name: str = ""
    arm_id: str = ""
    recipe: str = ""
    statement: str = ""


class RoundResult(Model):
    request_id: str
    run_id: str
    round: int
    rounds_planned: int
    impressions: int = 0
    buys: int = 0
    taps: int = 0
    jev_cost_usd: float = 0.0
    cache_hit_rate: float = 0.0
    leaderboard: list[LeaderRow] = []
    learnings_opened: list[LearningNote] = []
    winners: list[WinnerNote] = []
    new_winners: list[str] = []
    creatives_used: int = 0


class WinningAd(Model):
    segment_id: str
    segment_name: str = ""
    arm_id: str = ""
    recipe: str = ""
    statement: str = ""
    declared: bool = True
    p_best: float = 0.0
    cpo_usd: float | None = None
    control_cpo_usd: float | None = None
    creative_id: str = ""
    headline: str = ""
    primary_text: str = ""
    cta: str = ""
    visual_description: str = ""


class RunFinished(Model):
    request_id: str
    run_id: str
    rounds_completed: int
    winners: list[WinningAd] = []


class RunFailed(Model):
    request_id: str
    run_id: str
    task_id: str = ""
    kind: str = ""
    round: int = -1
    error: str
    hint: str = ""


# --- creatives (Copywriter -> Strategist) ---------------------------------------------------


class CreativesWritten(Model):
    run_id: str
    round: int
    task_id: str
    written: int = 0
    reused: int = 0
    ranked: int = 0
    gated_out: int = 0
    creative_ids: list[str] = []
    learning_ids_offered: list[str] = []
    learning_ids_applied: list[str] = []
    next_task: str | None = None
    claimed_by: str = "copywriter"
    handed_off: bool = False


# --- the five specs -------------------------------------------------------------------------

INTEL_SPEC = ProtocolSpecification(
    name="AdLabIntel",
    version=PROTO_VERSION,
    interactions={IntelRequest: {IntelReport}, IntelReport: set()},
    roles={"scout": {IntelRequest}, "ad_lab": {IntelReport}},
)

PROGRESS_SPEC = ProtocolSpecification(
    name="AdLabProgress",
    version=PROTO_VERSION,
    interactions={Progress: set()},
    roles={"ad_lab": {Progress}},
)

PLAN_SPEC = ProtocolSpecification(
    name="AdLabPlan",
    version=PROTO_VERSION,
    interactions={PlanRequest: {RecipePlan}, RecipePlan: set()},
    roles={"strategist": {PlanRequest}, "ad_lab": {RecipePlan}},
)

RUN_SPEC = ProtocolSpecification(
    name="AdLabRun",
    version=PROTO_VERSION,
    interactions={
        StartRun: {RunStarted, RunFailed},
        RunStarted: set(),
        RoundResult: set(),
        RunFinished: set(),
        RunFailed: set(),
    },
    roles={
        "strategist": {StartRun},
        "ad_lab": {RunStarted, RoundResult, RunFinished, RunFailed},
        "copywriter": {RunStarted, RunFinished, RunFailed},
    },
)

CREATIVES_SPEC = ProtocolSpecification(
    name="AdLabCreatives",
    version=PROTO_VERSION,
    interactions={CreativesWritten: set()},
    roles={"strategist": {CreativesWritten}},
)

# Protocol names as logged to agent_message (W2's hop table is canonical).
P_CHAT = "AgentChatProtocol"
P_INTEL = "AdLabIntel"
P_PROGRESS = "AdLabProgress"
P_PLAN = "AdLabPlan"
P_RUN = "AdLabRun"
P_CREATIVES = "AdLabCreatives"
