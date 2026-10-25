"""The five Interactive Cards Ad Lab posts in ASI:One, their plain-text fallbacks, and the
parser for what the user sends back.

Payloads are built as plain dicts shaped like uagents_core's card schemas, then validated and
wrapped with the installed helpers (create_card_content / validate_card_payload). If those
helpers are missing, the MetadataContent block is hand-built with the same wire format. Every
card is cut to <= 60,000 bytes of card_payload, and every builder returns a narration that
carries the same content as text, so a client that can't render cards loses nothing.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

try:  # uagents_core 0.4.12 ships these (chat/cards/__init__.py)
    from uagents_core.contrib.protocols.chat.cards import (
        create_card_content,
        create_card_response_content,
        extract_card,
        extract_card_response,
        validate_card_payload,
    )

    HAVE_CARD_HELPERS = True
except ImportError:  # pragma: no cover - fallback for an older uagents_core
    HAVE_CARD_HELPERS = False
    create_card_content = create_card_response_content = None  # type: ignore
    extract_card = extract_card_response = validate_card_payload = None  # type: ignore

MAX_CARD_BYTES = 60_000
MAX_VALUE = 300

TITLE_BRAND_SUFFIX = ": what customers say"
TITLE_COMPETITORS = "What's winning for competitors"
TITLE_RECIPES_SUFFIX = "ready to test"
TITLE_RECIPES_BLOCKED = "Recipes ready, but the run is blocked"
TITLE_ROUND_PREFIX = "Round "
TITLE_WINNERS = "Winning ads per segment"
STATUS_PREFIX = "Status:"


@dataclass
class CardOut:
    kind: str  # detail | carousel | review
    title: str
    payload: dict
    is_terminal: bool
    text: str  # markdown narration; the plain-text fallback

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "CardOut":
        return cls(kind=d["kind"], title=d["title"], payload=d["payload"],
                   is_terminal=bool(d.get("is_terminal")), text=d.get("text", ""))


# --- formatting helpers ---------------------------------------------------------------------


def label(tok: str | None) -> str:
    s = str(tok or "").replace("_", " ").strip()
    return s[:1].upper() + s[1:] if s else ""


def pct(x: Any) -> str:
    try:
        return f"{round(float(x) * 100)}%"
    except (TypeError, ValueError):
        return "n/a"


def money(x: Any) -> str:
    if x is None:
        return "n/a"
    try:
        return f"${float(x):,.2f}"
    except (TypeError, ValueError):
        return "n/a"


def cut(s: Any, n: int = MAX_VALUE) -> str:
    s = re.sub(r"\s+", " ", str(s if s is not None else "")).strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def recipe_of(angle: str, hook: str) -> str:
    return f"{label(angle)} × {label(hook)}"


def _row(lab: str, value: Any) -> dict:
    return {"label": cut(lab, 80) or "-", "value": cut(value) or "-"}


# --- size guard and wire format -------------------------------------------------------------


def payload_bytes(kind: str, payload: dict) -> int:
    if HAVE_CARD_HELPERS:
        model = validate_card_payload(kind, payload)
        return len(model.model_dump_json(exclude_none=True).encode())
    return len(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())


def fit(kind: str, payload: dict) -> dict:
    """Drop trailing rows or items until card_payload is <= 60,000 bytes."""
    list_key = "items" if kind == "carousel" else "summary_rows"
    while len(payload.get(list_key) or []) > 1 and payload_bytes(kind, payload) > MAX_CARD_BYTES:
        payload[list_key].pop()
    return payload


def to_content(card: CardOut | None) -> Any:
    """MetadataContent for a ChatMessage, or None if the card is invalid or too big (the caller
    then sends the narration alone)."""
    if card is None:
        return None
    try:
        if HAVE_CARD_HELPERS:
            model = validate_card_payload(card.kind, card.payload)
            block = create_card_content(model, card_id=uuid.uuid4(), is_terminal=card.is_terminal)
        else:
            from uagents_core.contrib.protocols.chat import MetadataContent

            meta = {
                "card_protocol_version": "1",
                "requires_card_interaction": "true",
                "card_kind": card.kind,
                "card_payload": json.dumps(card.payload, separators=(",", ":"), ensure_ascii=False),
                "card_id": str(uuid.uuid4()),
            }
            if card.is_terminal:
                meta["is_terminal"] = "true"
            block = MetadataContent(metadata=meta)
        if len(block.metadata["card_payload"].encode()) > MAX_CARD_BYTES:
            return None
        return block
    except Exception:
        return None


def _finish(kind: str, title: str, payload: dict, terminal: bool, text: str) -> CardOut:
    return CardOut(kind=kind, title=title, payload=fit(kind, payload), is_terminal=terminal,
                   text=text)


def _voice(items: list, n: int = 3) -> str:
    return " · ".join(f"{label(i.label)} ({i.frequency})" if i.frequency else label(i.label)
                      for i in items[:n])


# --- 1. brand profile (detail) --------------------------------------------------------------


def brand_card(report: Any) -> CardOut:
    b = report.brand
    title = f"{b.name or 'Magic Spoon'}{TITLE_BRAND_SUFFIX}"
    rows = []
    if b.positioning:
        rows.append(_row("Positioning", b.positioning))
    if b.proof_points:
        rows.append(_row("Proof points", "; ".join(b.proof_points[:4])))
    if b.pains:
        rows.append(_row("Top pains", _voice(b.pains)))
        if b.pains[0].quote:
            rows.append(_row("In their words", f'"{cut(b.pains[0].quote, 160)}"'))
    if b.desires:
        rows.append(_row("Top desires", _voice(b.desires)))
    if b.objections:
        rows.append(_row("Top objections", _voice(b.objections)))
    if b.personas:
        rows.append(_row("Personas", ", ".join(f"{p.name} {pct(p.share)}" for p in b.personas)))
    rows.append(_row("Refresh", refresh_line(report)))
    payload = {
        "title": cut(title, 120),
        "summary_rows": rows,
        "ctas": [{"label": "Show competitor winners",
                  "selection": {"action": "show_card", "card": "competitors"}, "primary": True}],
    }
    lines = [f"**{b.name or 'Magic Spoon'}**: {b.positioning or 'brand profile'}"]
    for r in rows[1:] if b.positioning else rows:
        lines.append(f"- {r['label']}: {r['value']}")
    return _finish("detail", payload["title"], payload, False, "\n".join(lines))


def refresh_line(report: Any) -> str:
    picks = list(report.picks or [])
    jobs = list(report.jobs or [])
    if not picks:
        return report.note or "Corpus is fresh; no refresh needed."
    names = ", ".join(p.target for p in picks[:4])
    if jobs and not report.dry:
        return f"Started {len(jobs)} Apify runs: {names}."
    return f"Picked {len(picks)} stale sources ({report.mode} mode, planned only): {names}."


# --- 2. competitor winners (carousel) -------------------------------------------------------


def competitors_card(report: Any) -> CardOut | None:
    c = report.competitors
    winners = list(c.winners or [])
    total_ads = sum(s.ads for s in c.competitors)
    patterns = ", ".join(f"{label(p.concept)} {pct(p.share)}" for p in (c.patterns or [])[:3])
    subtitle = f"{total_ads} ads from {len(c.competitors)} brands"
    if patterns:
        subtitle += f" · top patterns: {patterns}"
    lines = [f"**{TITLE_COMPETITORS}** ({subtitle})"]
    items = []
    for i, w in enumerate(winners[:8]):
        item = {
            "id": f"win_{i}",
            "title": cut(f"{w.brand}: {cut(w.headline or 'untitled ad', 80)}", 120),
            "subtitle": cut(recipe_of(w.angle, w.hook), 120),
            "badges": [{"label": f"{w.days_running} days running",
                        "variant": "success" if w.days_running >= 30 else "info"}],
            "primary_cta": {"label": "See our recipes",
                            "selection": {"action": "show_card", "card": "recipes"}},
        }
        if w.image_url:
            item["image"] = w.image_url
        items.append(item)
        lines.append(f"{i + 1}. {w.brand}: '{cut(w.headline, 80)}' "
                     f"({recipe_of(w.angle, w.hook)}, {w.days_running} days)")
    if not items:
        return None
    payload = {"title": TITLE_COMPETITORS, "subtitle": cut(subtitle, 200), "items": items}
    return _finish("carousel", TITLE_COMPETITORS, payload, False, "\n".join(lines))


# --- 3. recipes (review) --------------------------------------------------------------------


def recipes_card(plan: Any) -> CardOut:
    blocked = bool(plan.blocked_reason)
    recipes = sorted(plan.recipes, key=lambda r: (r.arm_id == "arm_control", r.arm_id))
    n = sum(1 for r in recipes if r.arm_id != "arm_control")
    title = TITLE_RECIPES_BLOCKED if blocked else f"{n} recipes + control, {TITLE_RECIPES_SUFFIX}"
    rows = []
    for r in recipes:
        name = r.arm_id.removeprefix("arm_")
        value = recipe_of(r.angle, r.hook) if r.angle else (r.strategy or "control")
        if r.rationale:
            value += f": {cut(r.rationale, 120)}"
        rows.append(_row(f"{name} · {r.strategy or 'recipe'}", value))
    if plan.segments:
        rows.append(_row("Segments", ", ".join(f"{s.name} {pct(s.share)}" for s in plan.segments)))
    rows.append(_row("Plan", f"{plan.rounds_planned} rounds after warm-up · "
                             f"{plan.population} shoppers · {plan.run_id}"))
    rows.append(_row("Database", f"{plan.db_name} ({'local' if plan.is_local else 'Maincloud'}, "
                                 f"{plan.mode})"))
    rows.append(_row("Round 0", f"{plan.round0_ranked}/{plan.round0_expected} ads ready"))
    if blocked:
        rows.append(_row("Blocked", plan.blocked_reason))
        approve = {"label": "Check again", "selection": {"action": "replan"}, "primary": True}
    else:
        approve = {"label": "Start the run",
                   "selection": {"action": "start_run", "plan_id": plan.plan_id}, "primary": True}
    payload = {
        "title": cut(title, 120),
        "summary_rows": rows,
        "approve_cta": approve,
        "reject_cta": {"label": "Not now", "selection": {"action": "cancel", "plan_id": plan.plan_id}},
    }
    lines = [f"**{title}**"] + [f"- {r['label']}: {r['value']}" for r in rows]
    if plan.rationale:
        lines.append(plan.rationale)
    if blocked:
        lines.append(f"Blocked: {plan.blocked_reason} Say **check again** after fixing it.")
    else:
        lines.append(f"Say **go** (or tap Start the run) to start {plan.run_id}, or **not now**.")
    return _finish("review", payload["title"], payload, False, "\n".join(lines))


# --- 4. leaderboard per round (detail, terminal) --------------------------------------------


def leaderboard_card(rr: Any) -> CardOut:
    title = f"{TITLE_ROUND_PREFIX}{rr.round} of {rr.rounds_planned}: leaderboard"
    rows = [_row("Shoppers", f"{rr.impressions} impressions · {rr.buys} orders · "
                             f"Jev {money(rr.jev_cost_usd)} · cache {pct(rr.cache_hit_rate)}")]
    if rr.creatives_used:
        rows.append(_row("New ads", f"Built on {rr.creatives_used} new ads from the Copywriter"))
    for row in rr.leaderboard:
        parts = [f"{i + 1}. {e.recipe or e.arm_id} p_best {e.p_best:.2f}, CPO {money(e.cpo_usd)}, "
                 f"{pct(e.share)} of traffic" for i, e in enumerate(row.top[:3])]
        value = "; ".join(parts) or "no traffic yet"
        if row.control is not None:
            value += f" | control CPO {money(row.control.cpo_usd)}"
        rows.append(_row(row.segment_name or row.segment_id, value))
    for note in rr.learnings_opened[:3]:
        rows.append(_row(f"New learning ({label(note.kind)})", cut(note.statement, 160)))
    for w in rr.winners:
        if w.segment_id in rr.new_winners:
            rows.append(_row("Winner", f"{w.segment_name}: {w.recipe}"))
    payload = {"title": cut(title, 120), "summary_rows": rows,
               "ctas": [{"label": "Status", "selection": {"action": "status"}}]}
    lines = [f"**{title}**"] + [f"- {r['label']}: {r['value']}" for r in rows]
    return _finish("detail", payload["title"], payload, True, "\n".join(lines))


# --- 5. winning ads per segment (carousel, terminal) ----------------------------------------


def winners_card(rf: Any) -> CardOut | None:
    subtitle = f"{rf.run_id} · {rf.rounds_completed} rounds"
    lines = [f"**{TITLE_WINNERS}** ({subtitle})"]
    items = []
    for i, w in enumerate(rf.winners):
        cpo = f"CPO {money(w.cpo_usd)} vs control {money(w.control_cpo_usd)}" \
            if w.cpo_usd is not None else ""
        item = {
            "id": w.creative_id or f"seg_{i}",
            "title": cut(f"{w.segment_name or w.segment_id}: {cut(w.headline or w.recipe, 80)}", 120),
            "subtitle": cut(w.recipe, 120),
            "badges": [{"label": "winner" if w.declared else "leader (not yet significant)",
                        "variant": "success" if w.declared else "warning"}],
            "secondary_text": cut(" · ".join(x for x in (w.primary_text, cpo) if x), 200),
            "primary_cta": {"label": "See full ad",
                            "selection": {"action": "show_ad", "creative_id": w.creative_id}},
        }
        if not item["secondary_text"]:
            del item["secondary_text"]
        items.append(item)
        lines.append(f"- {w.segment_name or w.segment_id}: '{cut(w.headline, 80)}': "
                     f"{cut(w.primary_text, 160)} ({w.recipe}"
                     f"{', winner' if w.declared else ', leading'}{'; ' + cpo if cpo else ''})")
    if not items:
        return None
    payload = {"title": TITLE_WINNERS, "subtitle": cut(subtitle, 200), "items": items}
    return _finish("carousel", TITLE_WINNERS, payload, True, "\n".join(lines))


# --- reading cards back (e2e) ---------------------------------------------------------------


def card_kind(card: Any) -> str:
    from uagents_core.contrib.protocols.chat.cards import card_kind_for_payload

    return card_kind_for_payload(card.payload)


def cards_in(msg: Any) -> list[Any]:
    """Validated Card requests in a ChatMessage (uses extract_card)."""
    from uagents_core.contrib.protocols.chat import MetadataContent

    out = []
    for block in getattr(msg, "content", []) or []:
        if isinstance(block, MetadataContent) and HAVE_CARD_HELPERS:
            card = extract_card(block)
            if card is not None:
                out.append(card)
    return out


# --- user input -----------------------------------------------------------------------------


@dataclass
class UserInput:
    intent: str  # request | go | cancel | status | replan | retry | show_card | show_ad | help | unknown
    args: dict = field(default_factory=dict)
    raw: str = ""
    source: str = "prose"  # card | json | prose


def from_selection(sel: dict, raw: str = "", source: str = "json") -> UserInput | None:
    action = str(sel.get("action") or "").strip().lower()
    if action == "start_run":
        return UserInput("go", {"plan_id": str(sel.get("plan_id") or "")}, raw, source)
    if action == "cancel":
        return UserInput("cancel", {"plan_id": str(sel.get("plan_id") or "")}, raw, source)
    if action in ("replan", "status"):
        return UserInput(action, {}, raw, source)
    if action == "show_card":
        return UserInput("show_card", {"card": str(sel.get("card") or "")}, raw, source)
    if action == "show_ad":
        return UserInput("show_ad", {"creative_id": str(sel.get("creative_id") or "")}, raw, source)
    return None


_PROSE: list[tuple[str, re.Pattern]] = [
    ("status", re.compile(r"\b(status|progress|update|where are we|how.?s it going)\b")),
    ("cancel", re.compile(r"\b(cancel|not now|stop|reject|no thanks|nope)\b")),
    ("retry", re.compile(r"\b(retry|try again|new run|run again|another run)\b")),
    ("replan", re.compile(r"\bcheck again\b")),
    ("go", re.compile(r"start_run|\b(go|start|start( the)? run|run it|approve[sd]?|yes|yep|launch"
                      r"|let.?s do it|do it|confirm(ed)?)\b")),
    ("request", re.compile(r"\b(find|beat|test|ads?|creatives?|recipes?|campaign|magic spoon"
                           r"|research|analy[sz]e)\b")),
    ("help", re.compile(r"^(hi|hello|hey|help|what can you do)\b")),
]
_SHOW_AD = re.compile(r"\b(cr_[a-z0-9_]+)\b")


def _json_selection(text: str) -> dict | None:
    candidates = [text]
    m = re.search(r"\{[^{}]*\"action\"[^{}]*\}", text)
    if m:
        candidates.append(m.group(0))
    for c in candidates:
        try:
            obj = json.loads(c)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict) and "action" in obj:
            return obj
    return None


def parse_user_input(msg: Any) -> UserInput:
    """In order: a card response (MetadataContent), then JSON in the text, then prose keywords."""
    from uagents_core.contrib.protocols.chat import MetadataContent, TextContent

    content = getattr(msg, "content", msg) or []
    text = "".join(b.text for b in content if isinstance(b, TextContent)).strip()
    for block in content:
        if not isinstance(block, MetadataContent):
            continue
        resp = extract_card_response(block) if HAVE_CARD_HELPERS else None
        if resp is None and not HAVE_CARD_HELPERS and "card_kind" not in block.metadata:
            sel_raw = block.metadata.get("selection")
            resp_sel = json.loads(sel_raw) if sel_raw else None
            if block.metadata.get("cancelled") == "true":
                return UserInput("cancel", {}, text, "card")
            if isinstance(resp_sel, dict):
                ui = from_selection(resp_sel, text, "card")
                if ui:
                    return ui
            continue
        if resp is None:
            continue
        if resp.cancelled:
            return UserInput("cancel", {}, text or (resp.text or ""), "card")
        if resp.selection:
            ui = from_selection(dict(resp.selection), text or (resp.text or ""), "card")
            if ui:
                return ui
        if resp.text and not text:
            text = resp.text.strip()
    sel = _json_selection(text) if text else None
    if sel:
        ui = from_selection(sel, text, "json")
        if ui:
            return ui
    low = text.lower()
    if not low:
        return UserInput("unknown", {}, text)
    if "selected" in low and "start" in low:
        return UserInput("go", {}, text)
    m = _SHOW_AD.search(low)
    if m and re.search(r"\b(show|see)\b", low):
        return UserInput("show_ad", {"creative_id": m.group(1)}, text)
    for intent, pattern in _PROSE:
        if pattern.search(low):
            return UserInput(intent, {}, text)
    return UserInput("unknown", {}, text)
