"""Strategist: recipes (contract/build check), the run on the task board, results and winners.

One worker interval owns all state: it drains the inbox (PlanRequest, StartRun,
CreativesWritten, direct chats), then watches the active run every `watch_s` seconds and emits
de-duplicated events (round results, calibration notes, warnings, failure, finish).
One run per database: a plan is blocked when /health says !runs_allowed or !run_slot_free.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from datetime import datetime
from typing import Any

import cards
import common
from common import AGENT_SPECS, ApiError, Hub, StatusReporter, clip, parse_ts, utcnow
from protocols import (
    CREATIVES_SPEC, P_CREATIVES, P_PLAN, P_PROGRESS, P_RUN, PLAN_SPEC, RUN_SPEC, CreativesWritten,
    LeaderEntry, LeaderRow, LearningNote, Persona, PlanRequest, Progress, RecipeItem, RecipePlan,
    RenderWinners, RoundResult, RunFailed, RunFinished, RunStarted, StartRun, WinnerNote, WinningAd,
    WinnersRendered)

SPEC = AGENT_SPECS["strategist"]
RESET_HINT = "Reset the database first (npm run bench:reset:local), then ask again."
CALIBRATION_NOTES_MIN = (3, 6, 10)
CALIBRATION_WARN_MIN = 15
WORKER_MISSING_S = 60
WORKER_MISSING_REPEAT_S = 300
COPYWRITER_LATE_S = 30
ROUND_STUCK_S = 600
START_REFUSALS = {"runs_not_allowed", "db_has_run", "round0_incomplete", "bad_request"}
# After the last round the Copywriter renders the winning ads with the product photo; the run is
# reported finished when it answers, or after this long either way.
RENDER_WAIT_S = 240
START_CHECK_TRIES = 6  # after a rounds/start timeout or drop: look for r0 for about 30 s
START_CHECK_GAP_S = 5.0

# --- pure helpers (unit-tested) -------------------------------------------------------------


def make_run_id(mode: str, now: datetime) -> str:
    """run_<mode>_<MMDD>_<HHMM> in UTC (timestamped, so agent storage that survives a database
    reset never mistakes a new run for an old one)."""
    m = re.sub(r"[^a-z0-9]", "", (mode or "test").lower())[:8] or "test"
    return f"run_{m}_{now.strftime('%m%d_%H%M')}"


_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}


def rounds_from_text(text: str) -> int | None:
    low = (text or "").lower()
    m = re.search(r"\b(\d+|one|two|three|four|five)\s+rounds?\b", low)
    if not m:
        return None
    tok = m.group(1)
    n = _WORDS.get(tok) or int(tok)
    return max(1, min(5, n))


def plan_blocked_reason(health: dict, cb: dict | None) -> str:
    """First match wins: protected database, a run already in this database, contract check,
    round 0 readiness."""
    db = health.get("db_name") or "?"
    if db in common.DENY_RUN_DBS or not health.get("runs_allowed"):
        extra = f" ({health['blocked_reason']})" if health.get("blocked_reason") else ""
        return f"Runs are disabled on {db}{extra}; agents never start a run there."
    if not health.get("run_slot_free", False):
        extra = f" ({health['blocked_reason']})" if health.get("blocked_reason") else ""
        return f"{db} already holds a run{extra}. Each database holds one run. {RESET_HINT}"
    if cb is None:
        return "The contract check didn't answer."
    check = cb.get("check") or {}
    if not check.get("ok"):
        fails = "; ".join(str(f) for f in (check.get("failures") or [])[:3]) or "unknown"
        return f"Contract check failed: {fails}"
    r0 = cb.get("round0") or {}
    if not r0.get("complete"):
        return f"Round 0 has {r0.get('ranked', 0)}/{r0.get('expected', 0)} ads ready."
    return ""


_ROUND_SUFFIX = re.compile(r"_r(\d+)$")


def task_round(task: dict) -> int:
    payload = task.get("payload") or {}
    if isinstance(payload, dict) and isinstance(payload.get("round"), int):
        return payload["round"]
    m = _ROUND_SUFFIX.search(str(task.get("task_id", "")))
    return int(m.group(1)) if m else -1


def _age_s(task: dict | None, now: datetime, key: str = "updated_at") -> float:
    if not task:
        return 0.0
    ts = parse_ts(task.get(key)) or parse_ts(task.get("created_at"))
    return max(0.0, (now - ts).total_seconds()) if ts else 0.0


def derive_phase(status: dict, now: datetime, rounds_planned: int, run_id: str = "") -> dict:
    """Phase of one run from /rounds/status (tasks + rounds), independent of the server's phase.
    Returns {name, round, task_id, age_s, claimed_by}."""
    run = status.get("run")
    tasks = [t for t in (status.get("tasks") or [])
             if not run_id or t.get("run_id") in (None, "", run_id)]
    rounds = {int(r.get("round", -1)): r for r in (status.get("rounds") or [])}

    def phase(name: str, rnd: int = -1, task: dict | None = None, age_key: str = "updated_at"):
        return {"name": name, "round": rnd, "task_id": (task or {}).get("task_id", ""),
                "age_s": _age_s(task, now, age_key), "claimed_by": (task or {}).get("claimed_by")}

    failed = [t for t in tasks if t.get("status") == "failed"]
    if failed:
        t = max(failed, key=task_round)
        return phase("failed", task_round(t), t)
    if run and run.get("status") == "done":
        return phase("done", rounds_planned)
    if not run and not tasks:
        return phase("lost")
    run_tasks = [t for t in tasks if t.get("kind") == "run_round"]
    gen_tasks = {task_round(t): t for t in tasks if t.get("kind") == "generate_creatives"}
    if not run_tasks:
        return phase("not_started")
    rr = max(run_tasks, key=task_round)
    r = task_round(rr)
    row = rounds.get(r)
    if rr.get("status") == "queued":
        return phase("waiting_for_worker", r, rr, "created_at")
    row_status = (row or {}).get("status")
    if rr.get("status") == "claimed" and row is None:
        return phase("calibrating" if r == 0 else "round_running", r, rr)
    if row_status == "running" or (rr.get("status") == "claimed" and row_status != "done"):
        return phase("round_running", r, rr)
    gen = gen_tasks.get(r)
    if gen is None:
        return phase("waiting_for_bandit", r, rr)
    if gen.get("status") == "queued":
        return phase("creatives_queued", r, gen, "created_at")
    if gen.get("status") == "claimed":
        return phase("writing_creatives", r, gen)
    return phase("waiting_for_worker", r + 1, gen)


# --- mapping API rows to messages -----------------------------------------------------------


def _entry(e: dict | None) -> LeaderEntry | None:
    if not e:
        return None
    return LeaderEntry(arm_id=str(e.get("arm_id", "")), recipe=str(e.get("recipe") or ""),
                       strategy=str(e.get("strategy") or ""), p_best=float(e.get("p_best") or 0),
                       cpo_usd=e.get("cpo_usd"), share=float(e.get("share") or 0))


def round_result(summary: dict, *, request_id: str, run_id: str, round_: int, rounds_planned: int,
                 declared: list[str], creatives_used: int) -> RoundResult:
    totals = summary.get("totals") or {}
    board = [LeaderRow(segment_id=str(row.get("segment_id", "")),
                       segment_name=str(row.get("segment_name") or row.get("segment_id", "")),
                       impressions=int(row.get("impressions") or 0),
                       top=[x for x in (_entry(e) for e in row.get("top") or []) if x],
                       control=_entry(row.get("control")))
             for row in summary.get("leaderboard") or []]
    notes = [LearningNote(learning_id=str(n.get("learning_id", "")),
                          segment_id=str(n.get("segment_id") or ""),
                          segment_name=str(n.get("segment_name") or ""),
                          arm_id=n.get("arm_id"), kind=str(n.get("kind") or ""),
                          statement=str(n.get("statement") or ""))
             for n in summary.get("learnings_opened") or []]
    winners = [WinnerNote(segment_id=str(w.get("segment_id", "")),
                          segment_name=str(w.get("segment_name") or ""),
                          arm_id=str(w.get("arm_id") or ""), recipe=str(w.get("recipe") or ""),
                          statement=str(w.get("statement") or ""))
               for w in summary.get("winners") or []]
    new = [w.segment_id for w in winners if w.segment_id not in declared]
    return RoundResult(
        request_id=request_id, run_id=run_id, round=round_,
        rounds_planned=int(summary.get("rounds_planned") or rounds_planned),
        impressions=int(totals.get("impressions") or 0), buys=int(totals.get("buys") or 0),
        taps=int(totals.get("taps") or 0),
        jev_cost_usd=float(totals.get("jev_cost_usd") or 0),
        cache_hit_rate=float(totals.get("cache_hit_rate") or 0),
        leaderboard=board, learnings_opened=notes, winners=winners, new_winners=new,
        creatives_used=creatives_used)


def winning_ads(rows: list[dict]) -> list[WinningAd]:
    out = []
    for w in rows:
        cr = w.get("creative") or {}
        out.append(WinningAd(
            segment_id=str(w.get("segment_id", "")), segment_name=str(w.get("segment_name") or ""),
            arm_id=str(w.get("arm_id") or ""), recipe=str(w.get("recipe") or ""),
            statement=str(w.get("statement") or ""),
            declared=bool(w.get("declared", w.get("basis") == "winner")),
            p_best=float(w.get("p_best") or 0), cpo_usd=w.get("cpo_usd"),
            control_cpo_usd=w.get("control_cpo_usd"),
            creative_id=str(cr.get("creative_id") or ""), headline=str(cr.get("headline") or ""),
            primary_text=str(cr.get("primary_text") or ""), cta=str(cr.get("cta") or ""),
            visual_description=str(cr.get("visual_description") or "")))
    return out


def rationale_for(rounds: int) -> str:
    return (f"{rounds} rounds after the warm-up: about {4 + rounds * 1.5:.0f} minutes of sim, "
            "enough for the bandit to move traffic to the leaders; more rounds mostly narrow "
            "the cost-per-order ranges.")


# --- the agent ------------------------------------------------------------------------------


class Strategist:
    def __init__(self, hub: Hub, address: str):
        self.hub = hub
        self.api = hub.api
        self.status = StatusReporter(hub, SPEC, address)
        self._last_watch = 0.0

    # -- storage (single writer: the worker interval) --
    def _active(self, ctx) -> dict | None:
        run_id = ctx.storage.get("strat:active")
        return ctx.storage.get(f"strat:run:{run_id}") if run_id else None

    def _save_run(self, ctx, rs: dict) -> None:
        ctx.storage.set(f"strat:run:{rs['run_id']}", rs)

    async def _progress(self, ctx, rs: dict | None, stage: str, text: str, level: str = "info",
                        request_id: str = "") -> None:
        msg = Progress(request_id=(rs or {}).get("request_id", request_id),
                       run_id=(rs or {}).get("run_id", ""), source="strategist", stage=stage,
                       text=text, level=level)
        await common.send_logged(self.hub, ctx, self.hub.peers.address("agt_ad_lab"), msg,
                                 protocol=P_PROGRESS, kind="progress", summary=text,
                                 run_id=msg.run_id)

    async def tick(self, ctx) -> None:
        for item in common.inbox_take(ctx.storage):
            try:
                t = item.get("t")
                if t == "PlanRequest":
                    await self.make_plan(ctx, item)
                elif t == "StartRun":
                    await self.start_run(ctx, item)
                elif t == "CreativesWritten":
                    self.record_creatives(ctx, item)
                elif t == "WinnersRendered":
                    self.record_render(ctx, item)
                elif t == "chat":
                    await common.answer_direct_chat(self.hub, ctx, SPEC, item, self.answer)
            except Exception as ex:
                ctx.logger.exception(f"strategist item failed: {ex}")
        rs = self._active(ctx)
        if rs and rs.get("state") == "starting":
            # start_run runs inside this sequential tick, so 'starting' here was left by a restart
            await self.resolve_start(ctx, rs)
            rs = self._active(ctx)
        now = utcnow().timestamp()
        if rs and rs.get("state") == "watching" and now - self._last_watch >= self.hub.cfg.watch_s:
            self._last_watch = now
            try:
                await self.watch(ctx, rs)
            except ApiError as ex:
                await self._warn_once(ctx, rs, "api", f"Strategist can't read the task board "
                                      f"({ex.code}); retrying.", every_s=60)
                self._save_run(ctx, rs)

    # -- plan --
    async def make_plan(self, ctx, item: dict) -> None:
        req = PlanRequest.parse_obj(item["data"])
        await self.status.set("working", "checking recipes and round 0")
        cfg = self.hub.cfg
        rounds = max(1, min(5, req.rounds_hint or cfg.rounds_planned))
        cb: dict | None = None
        health: dict = {}
        try:
            health = await self.api.health() or {}
            cb = await self.api.contract_build("check")
        except ApiError as ex:
            health = health or {"db_name": "?", "runs_allowed": False,
                                "blocked_reason": f"API unreachable ({ex.code})"}
        blocked = plan_blocked_reason(health, cb)
        cb = cb or {}
        check = cb.get("check") or {}
        r0 = cb.get("round0") or {}
        plan_id = "plan_" + uuid.uuid4().hex[:8]
        run_id = make_run_id(health.get("mode", "test"), utcnow())
        plan = RecipePlan(
            request_id=req.request_id, plan_id=plan_id, run_id=run_id, rounds_planned=rounds,
            recipes=[RecipeItem(arm_id=str(r.get("arm_id", "")), strategy=str(r.get("strategy") or ""),
                                angle=str(r.get("angle") or ""), hook=str(r.get("hook") or ""),
                                rationale=str(r.get("rationale") or ""))
                     for r in cb.get("recipes") or []],
            segments=[Persona(segment_id=str(s.get("segment_id", "")), name=str(s.get("name") or ""),
                              share=float(s.get("share") or 0)) for s in cb.get("segments") or []],
            check_ok=bool(check.get("ok")),
            check_failures=[clip(f, 200) for f in (check.get("failures") or [])[:5]],
            round0_complete=bool(r0.get("complete")), round0_expected=int(r0.get("expected") or 0),
            round0_ranked=int(r0.get("ranked") or 0), db_name=str(health.get("db_name") or ""),
            is_local=bool(health.get("is_local")), mode=str(health.get("mode") or "test"),
            runs_allowed=bool(health.get("runs_allowed")), blocked_reason=blocked,
            rationale=rationale_for(rounds))
        plans = ctx.storage.get("strat:plans") or {}
        plans[plan_id] = common.model_payload(plan)
        ctx.storage.set("strat:plans", dict(list(plans.items())[-10:]))
        n = sum(1 for r in plan.recipes if r.arm_id != "arm_control")
        summary = f"Plan {plan_id}: {n} recipes + control, {rounds} rounds, {run_id}" + \
            (f" (blocked: {blocked})" if blocked else "")
        await common.send_logged(self.hub, ctx, item["sender"], plan, protocol=P_PLAN, kind="reply",
                                 summary=summary, run_id=run_id)
        await self.status.set("idle", f"plan {plan_id} ready" + (" (blocked)" if blocked else ""))

    # -- start --
    async def _fail_start(self, ctx, to: str, req: StartRun, error: str, hint: str = "") -> None:
        msg = RunFailed(request_id=req.request_id, run_id=req.run_id, kind="start", error=error,
                        hint=hint)
        await common.send_logged(self.hub, ctx, to, msg, protocol=P_RUN, kind="result",
                                 summary=f"Run {req.run_id} not started: {error}", run_id=req.run_id)
        await self.status.set("idle", f"run {req.run_id} not started")

    async def _r0_queued(self, run_id: str, task_id: str, tries: int = 1) -> bool | None:
        """Is the run's round 0 task on the board? None when the board couldn't be read."""
        seen: bool | None = None
        for i in range(tries):
            if i:
                await asyncio.sleep(START_CHECK_GAP_S)
            try:
                st = await self.api.rounds_status(run_id) or {}
            except ApiError:
                continue
            seen = any(t.get("task_id") == task_id for t in st.get("tasks") or [])
            if seen:
                return True
        return seen

    async def _send_started(self, ctx, ad_lab: str, rs: dict, task_id: str) -> None:
        started = RunStarted(request_id=rs["request_id"], run_id=rs["run_id"], task_id=task_id,
                             rounds_planned=rs["rounds_planned"], db_name=rs.get("db_name", ""))
        summary = f"Queued {task_id} on {rs.get('db_name', '')} ({rs['rounds_planned']} rounds)"
        await common.send_logged(self.hub, ctx, ad_lab, started, protocol=P_RUN, kind="reply",
                                 summary=summary, run_id=rs["run_id"])
        await common.send_logged(self.hub, ctx, self.hub.peers.address("agt_copywriter"), started,
                                 protocol=P_RUN, kind="request",
                                 summary=f"Run {rs['run_id']} started: watch its creative tasks",
                                 run_id=rs["run_id"])
        await self.status.set("working", f"watching {rs['run_id']}")

    async def resolve_start(self, ctx, rs: dict) -> None:
        """A 'starting' run left by a restart: watching if round 0 is queued, else failed."""
        run_id = rs["run_id"]
        task_id = f"tsk_run_{run_id}_r0"
        queued = await self._r0_queued(run_id, task_id)
        if queued is None:
            return  # board unreachable: try again next tick
        ad_lab = self.hub.peers.address("agt_ad_lab")
        if queued:
            rs["state"] = "watching"
            self._save_run(ctx, rs)
            return await self._send_started(ctx, ad_lab, rs, task_id)
        rs["state"] = "failed"
        self._save_run(ctx, rs)
        ctx.storage.set("strat:active", None)
        req = StartRun(request_id=rs["request_id"], plan_id=rs.get("plan_id", ""), run_id=run_id,
                       rounds_planned=rs["rounds_planned"])
        await self._fail_start(ctx, ad_lab, req, "The start was interrupted before round 0 was "
                               "queued.", RESET_HINT)

    async def start_run(self, ctx, item: dict) -> None:
        req = StartRun.parse_obj(item["data"])
        ad_lab = item["sender"]
        plan = (ctx.storage.get("strat:plans") or {}).get(req.plan_id)
        if not plan or plan.get("run_id") != req.run_id:
            return await self._fail_start(ctx, ad_lab, req, "That plan is out of date.",
                                          "Ask for a new plan.")
        if plan.get("blocked_reason"):
            return await self._fail_start(ctx, ad_lab, req, plan["blocked_reason"], RESET_HINT)
        active = self._active(ctx)
        if active and active.get("run_id") == req.run_id \
                and active.get("state") in ("starting", "watching"):
            # the same StartRun again (inbox redelivery after a restart): don't refuse it
            r0 = f"tsk_run_{req.run_id}_r0"
            if active["state"] == "watching" or await self._r0_queued(req.run_id, r0):
                active["state"] = "watching"
                self._save_run(ctx, active)
                return await self._send_started(ctx, ad_lab, active, r0)
            # round 0 isn't queued yet: start it below
        elif active and active.get("state") in ("starting", "watching"):
            return await self._fail_start(ctx, ad_lab, req,
                                          f"A run is already in progress: {active['run_id']}.")
        await self.status.set("working", f"starting {req.run_id}")
        try:
            health = await self.api.health() or {}
        except ApiError as ex:
            return await self._fail_start(ctx, ad_lab, req, f"API unreachable ({ex.code}).")
        blocked = plan_blocked_reason(health, {"check": {"ok": True}, "round0": {"complete": True}})
        if blocked:
            return await self._fail_start(ctx, ad_lab, req, blocked, RESET_HINT)
        rounds = int(plan.get("rounds_planned") or req.rounds_planned)
        rs = {"run_id": req.run_id, "request_id": req.request_id, "plan_id": req.plan_id,
              "rounds_planned": rounds, "plan_rounds": rounds, "state": "starting",
              "started_at": common.iso(), "emitted": [], "declared": [], "creatives": {},
              "last_warn": {}, "phase": "", "phase_since": utcnow().timestamp(),
              "db_name": health.get("db_name", ""), "db_uri": health.get("db_uri", ""),
              "is_local": bool(health.get("is_local"))}
        self._save_run(ctx, rs)
        ctx.storage.set("strat:active", req.run_id)
        task_id = f"tsk_run_{req.run_id}_r0"
        try:
            res = await self.api.rounds_start({
                "run_id": req.run_id, "rounds_planned": rounds, "population": 300, "seed": 13,
                "requested_by": SPEC.agent_id})
            task_id = (res or {}).get("task_id") or task_id
            rs["rounds_planned"] = int((res or {}).get("rounds_planned") or rounds)
        except ApiError as ex:
            resumed = False
            if ex.code not in START_REFUSALS:
                # a timeout or dropped connection may still have started the run (and run_exists
                # means it did): look for round 0 before calling it a failure
                resumed = bool(await self._r0_queued(req.run_id, task_id, START_CHECK_TRIES))
            if not resumed:
                rs["state"] = "failed"
                self._save_run(ctx, rs)
                ctx.storage.set("strat:active", None)
                hints = {"db_has_run": RESET_HINT, "run_exists": RESET_HINT,
                         "round0_incomplete": "Round 0 isn't fully written; check A5's round 0.",
                         "runs_not_allowed": "Agents never start a run on this database."}
                return await self._fail_start(ctx, ad_lab, req, f"{ex.code}: {clip(ex.message, 200)}",
                                              hints.get(ex.code, ""))
        rs["state"] = "watching"
        self._save_run(ctx, rs)
        await self._send_started(ctx, ad_lab, rs, task_id)

    def record_creatives(self, ctx, item: dict) -> None:
        cw = item["data"]
        rs = ctx.storage.get(f"strat:run:{cw.get('run_id')}")
        if rs is None:
            return
        rs.setdefault("creatives", {})[str(cw.get("round"))] = cw
        self._save_run(ctx, rs)

    def record_render(self, ctx, item: dict) -> None:
        wr = item["data"]
        rs = ctx.storage.get(f"strat:run:{wr.get('run_id')}")
        if rs is None:
            return
        rs.setdefault("render", {}).update(done=True, result=wr)
        self._save_run(ctx, rs)

    # -- watch --
    async def _warn_once(self, ctx, rs: dict, key: str, text: str, level: str = "warn",
                         every_s: float | None = None) -> None:
        now = utcnow().timestamp()
        last = rs.setdefault("last_warn", {}).get(key)
        if last is not None and (every_s is None or now - last < every_s):
            return
        rs["last_warn"][key] = now
        await self._progress(ctx, rs, key.split(":")[0], text, level)

    def _render_pending(self, rs: dict, now: float) -> bool:
        """After the last round the Copywriter renders the winning ads with the product photo
        (RenderWinners). True while that is still going: asked, no reply, under RENDER_WAIT_S."""
        render = rs.get("render") or {}
        return bool(render.get("asked_at")) and not render.get("done") \
            and now - float(render["asked_at"]) < RENDER_WAIT_S

    async def ask_render(self, ctx, rs: dict) -> None:
        rs["render"] = {"asked_at": utcnow().timestamp()}
        self._save_run(ctx, rs)
        await common.send_logged(self.hub, ctx, self.hub.peers.address("agt_copywriter"),
                                 RenderWinners(request_id=rs["request_id"], run_id=rs["run_id"]),
                                 protocol=P_CREATIVES, kind="request",
                                 summary=f"Render {rs['run_id']}'s winning ads with the product photo",
                                 run_id=rs["run_id"])

    async def _emit_run_end(self, ctx, rs: dict, msg: Any, summary: str) -> None:
        for agent_id in ("agt_ad_lab", "agt_copywriter"):
            await common.send_logged(self.hub, ctx, self.hub.peers.address(agent_id), msg,
                                     protocol=P_RUN, kind="result", summary=summary,
                                     run_id=rs["run_id"])

    async def watch(self, ctx, rs: dict) -> None:
        run_id = rs["run_id"]
        st = await self.api.rounds_status(run_id) or {}
        now_dt = utcnow()
        now = now_dt.timestamp()
        run = st.get("run")
        if run and run.get("rounds_planned"):
            r_run = int(run["rounds_planned"])
            if r_run != rs["rounds_planned"]:
                await self._warn_once(ctx, rs, "rounds_mismatch",
                                      f"The run row says {r_run} rounds, not the planned "
                                      f"{rs['rounds_planned']}; following the run row.")
                rs["rounds_planned"] = r_run
        R = rs["rounds_planned"]
        ph = derive_phase(st, now_dt, R, run_id)
        if ph["name"] != rs.get("phase"):
            rs["phase"] = ph["name"]
            rs["phase_since"] = now
        in_phase = now - rs.get("phase_since", now)
        emitted: list = rs.setdefault("emitted", [])

        # 1. one RoundResult per finished round, in order
        done_rounds = sorted(int(r["round"]) for r in st.get("rounds") or []
                             if r.get("status") == "done" and 0 <= int(r.get("round", -1)) <= R)
        for r in done_rounds:
            key = f"round_done:{r}"
            if key in emitted:
                continue
            try:
                summary = await self.api.rounds_summary(run_id, r) or {}
            except ApiError as ex:
                if ex.code == "not_ready":
                    break
                raise
            prev = (rs.get("creatives") or {}).get(str(r - 1)) or {}
            result = round_result(summary, request_id=rs["request_id"], run_id=run_id, round_=r,
                                  rounds_planned=R, declared=rs.get("declared", []),
                                  creatives_used=int(prev.get("ranked") or 0))
            await common.send_logged(self.hub, ctx, self.hub.peers.address("agt_ad_lab"), result,
                                     protocol=P_RUN, kind="result",
                                     summary=f"{cards.round_line(result)}. {cards.best_vs_control(result)}",
                                     run_id=run_id)
            emitted.append(key)
            rs.setdefault("declared", []).extend(result.new_winners)
            self._save_run(ctx, rs)

        # 2-7. phase notes and warnings
        name, rnd = ph["name"], ph["round"]
        if name == "calibrating":
            if "calibrating" not in emitted:
                emitted.append("calibrating")
                await self._progress(ctx, rs, "calibrating",
                                     "B's sim worker took round 0 and is calibrating Jev (about "
                                     "1,456 questions; it stays quiet for a few minutes).")
            minutes = in_phase / 60
            for m in CALIBRATION_NOTES_MIN:
                if minutes >= m and f"calib:{m}" not in emitted:
                    emitted.append(f"calib:{m}")
                    await self._progress(ctx, rs, "calibrating",
                                         f"Still calibrating ({m} min in).")
            if minutes >= CALIBRATION_WARN_MIN and "calib:warn" not in emitted:
                emitted.append("calib:warn")
                await self._progress(ctx, rs, "calibrating", "Calibration is taking unusually long; "
                                     "check the sim worker's terminal.", "warn")
        if name == "round_running" and rnd >= 0 and f"round_running:{rnd}" not in emitted:
            emitted.append(f"round_running:{rnd}")
            await self._progress(ctx, rs, "round_running",
                                 f"Round {rnd} of {R} is running: 300 shoppers, 3 sim days.")
        if name == "waiting_for_worker" and ph["task_id"].startswith("tsk_run_") \
                and max(ph["age_s"], in_phase) >= WORKER_MISSING_S:
            uri = rs.get("db_uri") or ("http://127.0.0.1:3100" if rs.get("is_local")
                                       else "https://maincloud.spacetimedb.com")
            await self._warn_once(
                ctx, rs, "worker_missing",
                f"No sim worker has picked up {ph['task_id']}. Start B's worker on {rs['db_name']}: "
                f"SPACETIMEDB_URI={uri} SPACETIMEDB_DB_NAME={rs['db_name']} npm --prefix sim run "
                f"sim:worker (no --auto-next).", every_s=WORKER_MISSING_REPEAT_S)
        tasks = st.get("tasks") or []
        for t in tasks:
            if t.get("kind") != "generate_creatives" or t.get("status") != "queued":
                continue
            r = task_round(t)
            if _age_s(t, now_dt, "created_at") >= COPYWRITER_LATE_S:
                await self._warn_once(ctx, rs, f"copywriter_late:{r}",
                                      f"The Copywriter hasn't picked up round {r}'s creative task; "
                                      "A5's fallback worker takes it at 60 s if it's running.")
            nxt = f"tsk_run_{run_id}_r{r + 1}"
            if any(x.get("task_id") == nxt for x in tasks):
                await self._warn_once(ctx, rs, f"auto_next:{r}",
                                      f"Round {r + 1} was queued while round {r}'s creative task is "
                                      "still waiting: B's worker may be running with --auto-next, "
                                      "so the new ads land a round late.")
        if name == "round_running" and in_phase >= ROUND_STUCK_S:
            await self._warn_once(ctx, rs, f"round_stuck:{rnd}",
                                  f"Round {rnd} has been running for {in_phase / 60:.0f} minutes; "
                                  "check the sim worker.")

        # 8-10. terminal phases
        if name == "failed":
            task = next((t for t in tasks if t.get("task_id") == ph["task_id"]), {})
            err = clip(str((task.get("result") or {}).get("error", "")) or "unknown error", 300)
            kind = task.get("kind", "")
            hint = ("B's worker logged the error; the round and run rows stay 'running'. "
                    if kind == "run_round" else
                    "The creative task failed after the Copywriter's retries; see the Next log. ")
            msg = RunFailed(request_id=rs["request_id"], run_id=run_id, task_id=ph["task_id"],
                            kind=kind, round=rnd, error=err, hint=hint + RESET_HINT)
            await self._emit_run_end(ctx, rs, msg, f"Run {run_id} failed at {kind} round {rnd}")
            rs["state"] = "failed"
            ctx.storage.set("strat:active", None)
            await self.status.set("error", f"run {run_id} failed")
        elif name == "lost":
            msg = RunFailed(request_id=rs["request_id"], run_id=run_id,
                            error="run not found; the database was reset", hint=RESET_HINT)
            await self._emit_run_end(ctx, rs, msg, f"Run {run_id} lost: database was reset")
            rs["state"] = "lost"
            ctx.storage.set("strat:active", None)
            await self.status.set("error", f"run {run_id} lost")
        elif name == "done" and all(f"round_done:{r}" in emitted for r in range(R + 1)) \
                and not rs.get("render"):
            await self.status.set("working", f"{run_id}: waiting for the winning ads' images")
            await self.ask_render(ctx, rs)
        elif name == "done" and all(f"round_done:{r}" in emitted for r in range(R + 1)) \
                and not self._render_pending(rs, now):
            try:
                rows = (await self.api.rounds_winners(run_id) or {}).get("winners") or []
            except ApiError:
                rows = []
            # One rendered ad per segment: the segment's best-scoring ad of the winning recipe,
            # which can be an earlier round's copy than the one the winners table names.
            rendered = {r.get("segment_id"): r for r in
                        ((rs.get("render") or {}).get("result") or {}).get("rendered") or []}
            winners = winning_ads(rows)
            for w in winners:
                if w.segment_id in rendered:
                    w.image_rendered = True
                    w.image_url = str(rendered[w.segment_id].get("image_url") or "")
            msg = RunFinished(request_id=rs["request_id"], run_id=run_id, rounds_completed=R,
                              winners=winners, images_rendered=len(rendered))
            declared = sum(1 for w in msg.winners if w.declared)
            await self._emit_run_end(ctx, rs, msg, f"Run {run_id} done: {declared} winners, "
                                     f"{len(msg.winners) - declared} leaders")
            rs["state"] = "done"
            ctx.storage.set("strat:active", None)
            await self.status.set("idle", f"run {run_id} done")
        elif name not in ("done",):
            await self.status.set("working", f"{run_id}: {name.replace('_', ' ')}"
                                  + (f" (round {rnd})" if rnd >= 0 else ""))
        self._save_run(ctx, rs)

    # -- direct chat --
    async def answer(self, ctx, text: str) -> str:
        rs = self._active(ctx)
        if "status" in text.lower() and rs:
            return (f"{rs['run_id']}: {rs.get('phase', 'starting').replace('_', ' ')}; "
                    f"{len([e for e in rs.get('emitted', []) if e.startswith('round_done')])} of "
                    f"{rs['rounds_planned'] + 1} rounds reported.")
        plans = ctx.storage.get("strat:plans") or {}
        if plans:
            plan = RecipePlan.parse_obj(list(plans.values())[-1])
            lines = [f"Last plan {plan.plan_id} ({plan.run_id}, {plan.rounds_planned} rounds):"]
            lines += [f"- {r.arm_id}: {r.strategy}, {r.angle} × {r.hook}" for r in plan.recipes[:12]]
            if plan.blocked_reason:
                lines.append(f"Blocked: {plan.blocked_reason}")
            return "\n".join(lines)
        return ("I'm Ad Lab's Strategist: I check A4's recipes, queue the rounds on the task board "
                "and call the winners. Ask Ad Lab to start a test; ask me for 'status' during a run.")


def build(hub: Hub, *, offline: bool, port: int | None = None) -> Any:
    from uagents import Protocol

    agent = common.make_agent(SPEC, hub.cfg.seeds["strategist"], port=port or SPEC.solo_port,
                              offline=offline)
    s = Strategist(hub, agent.address)
    common.add_chat_inbox(agent, offline)
    plan = Protocol(spec=PLAN_SPEC, role="strategist")
    plan.on_message(PlanRequest)(common.typed_to_inbox(PlanRequest))
    run = Protocol(spec=RUN_SPEC, role="strategist")
    run.on_message(StartRun)(common.typed_to_inbox(StartRun))
    creatives = Protocol(spec=CREATIVES_SPEC, role="strategist")
    creatives.on_message(CreativesWritten)(common.typed_to_inbox(CreativesWritten))
    creatives.on_message(WinnersRendered)(common.typed_to_inbox(WinnersRendered))
    for proto in (plan, run, creatives):
        agent.include(proto, publish_manifest=not offline)

    @agent.on_event("startup")
    async def _startup(ctx):
        await s.status.set("idle", "online")

    @agent.on_interval(hub.cfg.strategist_s)
    async def _work(ctx):
        await s.tick(ctx)

    @agent.on_interval(60)
    async def _heartbeat(ctx):
        await s.status.heartbeat()

    agent._adlab = s  # for the e2e harness
    return agent
