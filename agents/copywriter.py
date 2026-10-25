"""Copywriter: writes each round's new ads by claiming its generate_creatives task.

Every `poll_s` (about 3 s) it polls GET /tasks?kind=generate_creatives&status=queued&run_id= for
the runs its own Strategist announced, chooses which learnings to apply (GET /learnings and a
concrete rule), and calls POST /creatives/generate {task_id, learning_ids}. A5's route claims
the task as 'copywriter', writes, queues the next run_round and completes it.

Failure model (contract v1): the route never fails the task itself.
- generate_failed: retry 3 times (20, 40, 80 s), then POST /creatives/fail.
- claim_lost: A5's fallback worker took it; report the hand-off and don't fight. If the task
  is still queued or held by the Copywriter (or nobody), it wasn't lost: retry in 10 s.
- timeout: the route keeps running server-side; poll GET /tasks?task_id= until it's done, and
  call the route again while the task is still ours (a repeat call joins the in-flight one).
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

import common
from common import AGENT_SPECS, ApiError, Hub, StatusReporter, clip, utcnow
from protocols import (
    P_CREATIVES, P_PROGRESS, RUN_SPEC, CreativesWritten, Progress, RunFailed, RunFinished,
    RunStarted)

SPEC = AGENT_SPECS["copywriter"]
KIND_RANK = {"claim_doubt": 0, "objection": 1, "winner": 2}
# Objections about timing ("not needing cereal yet"): whether a shopper is in the market right now,
# which no headline changes. The Copywriter leaves them out and says so.
TIMING_TOPICS = {"not_now"}


def is_timing(learning: dict) -> bool:
    return learning.get("kind") == "objection" and learning.get("topic") in TIMING_TOPICS
_DIGIT = re.compile(r"\d")


# --- the learning rule (pure, unit-tested) --------------------------------------------------


def choose_learnings(payload: dict, learnings: list[dict] | None,
                     cap: int = 3) -> tuple[list[str], list[str]]:
    """Which of the task's offered learnings to apply.

    For each (arm a, segment s) in the payload, the candidates are live learnings
    (valid_to_round null) among payload.learning_ids with segment_id == s and arm_id in
    (None, '', a). Drop timing objections (TIMING_TOPICS: copy can't change when someone shops),
    any whose directive is empty or contains a digit (A5 drops those too), and duplicate directives. Rank: this arm's own learning first, then claim_doubt, objection,
    winner, then the newest valid_from_round. Keep at most `cap` per segment.
    Returns (learning ids in rank order, one reason line per segment). With learnings=None
    (GET /learnings unavailable) it applies every offered id.
    """
    offered = [str(x) for x in (payload.get("learning_ids") or [])]
    if learnings is None:
        return offered, ["learnings unavailable: applying every offered learning"]
    offered_set = set(offered)
    chosen: list[str] = []
    reasons: list[str] = []
    for arm in payload.get("arms") or []:
        arm_id = str(arm.get("arm_id", ""))
        for seg in arm.get("segment_ids") or []:
            cands = [l for l in learnings
                     if l.get("learning_id") in offered_set and l.get("segment_id") == seg
                     and (l.get("arm_id") in (None, "", arm_id))
                     and l.get("valid_to_round") in (None, "")]
            kept, seen, skipped, timing = [], set(), 0, 0
            for l in cands:
                if is_timing(l):
                    timing += 1
                    continue
                directive = str(l.get("directive") or "").strip()
                if not directive or _DIGIT.search(directive) or directive.lower() in seen:
                    skipped += 1
                    continue
                seen.add(directive.lower())
                kept.append(l)
            kept.sort(key=lambda l: (0 if l.get("arm_id") == arm_id else 1,
                                     KIND_RANK.get(str(l.get("kind")), 9),
                                     -int(l.get("valid_from_round") or 0)))
            over = max(0, len(kept) - cap)
            kept = kept[:cap]
            for l in kept:
                if l["learning_id"] not in chosen:
                    chosen.append(l["learning_id"])
            name = (kept[0].get("segment_name") if kept else None) or seg
            kinds = " + ".join(str(l.get("kind", "")).replace("_", " ") for l in kept) or "none"
            extra = []
            if timing:
                extra.append(f"left out {timing} timing objection{'s' if timing > 1 else ''}")
            if skipped:
                extra.append(f"dropped {skipped}")
            if over:
                extra.append(f"skipped {over} (cap {cap})")
            reasons.append(f"{name}: {kinds}" + (f"; {', '.join(extra)}" if extra else ""))
    return chosen, reasons


# --- the agent ------------------------------------------------------------------------------


class Copywriter:
    def __init__(self, hub: Hub, address: str):
        self.hub = hub
        self.api = hub.api
        self.status = StatusReporter(hub, SPEC, address)
        self._last_poll = 0.0

    def _runs(self, ctx) -> dict:
        return ctx.storage.get("cw:runs") or {}

    def _tasks(self, ctx) -> dict:
        tasks = ctx.storage.get("cw:tasks") or {}
        for st in tasks.values():
            if st.get("state") == "generating":
                st["state"] = "unknown"  # the tick is sequential: a stored call is from before a restart
        return tasks

    async def _progress(self, ctx, run: dict, run_id: str, stage: str, text: str,
                        level: str = "info") -> None:
        msg = Progress(request_id=run.get("request_id", ""), run_id=run_id, source="copywriter",
                       stage=stage, text=text, level=level)
        await common.send_logged(self.hub, ctx, self.hub.peers.address("agt_ad_lab"), msg,
                                 protocol=P_PROGRESS, kind="progress", summary=text, run_id=run_id)

    async def _report(self, ctx, run_id: str, cw: CreativesWritten, summary: str) -> None:
        await common.send_logged(self.hub, ctx, self.hub.peers.address("agt_strategist"), cw,
                                 protocol=P_CREATIVES, kind="result", summary=summary,
                                 run_id=run_id)
        last = common.model_payload(cw)
        ctx.storage.set("cw:last", last)

    async def tick(self, ctx) -> None:
        runs = self._runs(ctx)
        for item in common.inbox_take(ctx.storage):
            t = item.get("t")
            try:
                if t == "RunStarted":
                    m = RunStarted.parse_obj(item["data"])
                    runs[m.run_id] = {"request_id": m.request_id, "active": True,
                                      "rounds_planned": m.rounds_planned}
                    await self.status.set("working", f"watching {m.run_id} for creative tasks")
                elif t in ("RunFinished", "RunFailed"):
                    model = RunFinished if t == "RunFinished" else RunFailed
                    m = model.parse_obj(item["data"])
                    if m.run_id in runs:
                        runs[m.run_id]["active"] = False
                    await self.status.set("idle", f"{m.run_id} {'done' if t == 'RunFinished' else 'stopped'}")
                elif t == "chat":
                    await common.answer_direct_chat(self.hub, ctx, SPEC, item, self.answer)
            except Exception as ex:
                ctx.logger.exception(f"copywriter item failed: {ex}")
        ctx.storage.set("cw:runs", runs)
        now = utcnow().timestamp()
        if now - self._last_poll < self.hub.cfg.poll_s:
            return
        self._last_poll = now
        tasks = self._tasks(ctx)
        for run_id, run in runs.items():
            if not run.get("active"):
                continue
            # retries and timed-out calls first
            for task_id, st in list(tasks.items()):
                if st.get("run_id") != run_id:
                    continue
                if st.get("state") == "retry_wait" and now >= st.get("next_try", 0):
                    await self._generate(ctx, run_id, run, task_id, st, tasks)
                elif st.get("state") == "unknown":
                    await self._check_unknown(ctx, run_id, run, task_id, st, tasks)
            try:
                res = await self.api.tasks(kind="generate_creatives", status="queued", run_id=run_id)
            except ApiError as ex:
                await self.status.set("error", f"task board unreachable ({ex.code})")
                continue
            for t in sorted((res or {}).get("tasks") or [], key=lambda x: str(x.get("task_id"))):
                task_id = str(t.get("task_id"))
                st = tasks.get(task_id)
                if st and st.get("state") not in ("deciding",):
                    continue  # already ours, done, handed off or failed
                await self._decide_and_write(ctx, run_id, run, t, tasks)
        ctx.storage.set("cw:tasks", tasks)

    async def _decide_and_write(self, ctx, run_id: str, run: dict, t: dict, tasks: dict) -> None:
        task_id = str(t.get("task_id"))
        payload = t.get("payload") or {}
        offered = [str(x) for x in payload.get("learning_ids") or []]
        st = {"run_id": run_id, "state": "deciding", "attempts": 0, "offered": offered,
              "round": int(payload.get("round", common_round(task_id))), "first_seen": common.iso()}
        tasks[task_id] = st
        await self.status.set("working", f"choosing learnings for {task_id}")
        learnings: list[dict] | None
        try:
            learnings = ((await self.api.learnings(run_id, offered)) or {}).get("learnings")
        except ApiError:
            learnings = None
        chosen, reasons = choose_learnings(payload, learnings)
        st["chosen"] = chosen if learnings is not None else []
        st["reasons"] = reasons
        arms = payload.get("arms") or []
        segs = sum(len(a.get("segment_ids") or []) for a in arms)
        kinds = Counter(str(l.get("kind")) for l in (learnings or [])
                        if l.get("learning_id") in set(chosen))
        kind_txt = ", ".join(f"{n} {k.replace('_', ' ')}" for k, n in kinds.items()) or "none"
        timing = sum(1 for l in learnings or [] if l.get("learning_id") in set(offered) and is_timing(l))
        why = (f" Left out {timing} timing objection{'s' if timing > 1 else ''} (\"not needing "
               "cereal yet\" is about when they shop, not what the ad says).") if timing else ""
        r = st["round"]
        await self._progress(ctx, run, run_id, "creatives_writing",
                             f"Copywriter is writing round {r + 1}'s ads: {len(arms)} recipes for "
                             f"{segs} segments, applying {len(chosen)} of {len(offered)} learnings "
                             f"({kind_txt}).{why}")
        await self._generate(ctx, run_id, run, task_id, st, tasks)

    async def _generate(self, ctx, run_id: str, run: dict, task_id: str, st: dict,
                        tasks: dict) -> None:
        st["state"] = "generating"
        ctx.storage.set("cw:tasks", tasks)
        await self.status.set("working", f"writing {task_id}")
        try:
            res = await self.api.creatives_generate(task_id, st.get("chosen") or None)
        except ApiError as ex:
            await self._on_error(ctx, run_id, run, task_id, st, ex)
            return
        await self._done(ctx, run_id, run, task_id, st, res or {})

    async def _on_error(self, ctx, run_id: str, run: dict, task_id: str, st: dict,
                        ex: ApiError) -> None:
        r = st.get("round", 0)
        if ex.code == "claim_lost":
            row: dict = {}
            try:
                rows = ((await self.api.tasks(task_id=task_id)) or {}).get("tasks") or []
                row = rows[0] if rows else {}
            except ApiError:
                pass
            claimed_by = row.get("claimed_by")
            if row.get("status") == "queued" or claimed_by in (None, "", "copywriter"):
                # not taken by another worker: retry instead of standing down
                st["attempts"] = int(st.get("attempts", 0)) + 1
                if st["attempts"] <= len(self.hub.cfg.retry_delays):
                    st["state"] = "retry_wait"
                    st["next_try"] = utcnow().timestamp() + 10
                    await self.status.set("working", f"{task_id} claim unclear; retrying in 10s")
                    return
                return await self._give_up(ctx, run_id, run, task_id, st, ex)
            st["state"] = "handed_off"
            await self._progress(ctx, run, run_id, "handoff",
                                 f"A5's fallback worker ({claimed_by}) took round {r}'s creative "
                                 "task; the Copywriter stands down.")
            cw = CreativesWritten(run_id=run_id, round=r, task_id=task_id,
                                  learning_ids_offered=st.get("offered", []),
                                  claimed_by=str(claimed_by), handed_off=True)
            await self._report(ctx, run_id, cw, f"Round {r} creatives handed off to {claimed_by}")
            await self.status.set("working", f"watching {run_id}")
            return
        if ex.code == "timeout":
            st["state"] = "unknown"
            await self.status.set("working", f"{task_id} still writing on the server")
            return
        if ex.code in ("api_down", "no_route"):
            st["state"] = "retry_wait"
            st["next_try"] = utcnow().timestamp() + 10
            await self.status.set("error", f"API unreachable ({ex.code})")
            return
        # generate_failed (or any other refusal): the task stays claimed by 'copywriter'
        st["attempts"] = int(st.get("attempts", 0)) + 1
        delays = self.hub.cfg.retry_delays
        if st["attempts"] <= len(delays):
            delay = delays[st["attempts"] - 1]
            st["state"] = "retry_wait"
            st["next_try"] = utcnow().timestamp() + delay
            await self._progress(ctx, run, run_id, "creatives_retry",
                                 f"Copywriter's write for round {r} failed ({clip(ex.message or ex.code, 90)}); "
                                 f"retrying in {delay:.0f} s (attempt {st['attempts']} of {len(delays)}).",
                                 "warn")
            await self.status.set("working", f"retrying {task_id} in {delay:.0f}s")
            return
        await self._give_up(ctx, run_id, run, task_id, st, ex)

    async def _give_up(self, ctx, run_id: str, run: dict, task_id: str, st: dict,
                       ex: ApiError) -> None:
        r = st.get("round", 0)
        delays = self.hub.cfg.retry_delays
        st["state"] = "failed"
        try:
            await self.api.creatives_fail(task_id, f"copywriter gave up after {len(delays)} "
                                                   f"retries: {ex.message or ex.code}")
        except ApiError as fail_ex:
            ctx.logger.error(f"creatives/fail failed: {fail_ex}")
        await self._progress(ctx, run, run_id, "creatives_failed",
                             f"Round {r}'s creative task failed after {len(delays)} retries: "
                             f"{clip(ex.message or ex.code, 150)}", "error")
        await self.status.set("error", f"{task_id} failed")

    async def _check_unknown(self, ctx, run_id: str, run: dict, task_id: str, st: dict,
                             tasks: dict) -> None:
        try:
            rows = ((await self.api.tasks(task_id=task_id)) or {}).get("tasks") or []
        except ApiError:
            return
        if not rows:
            return
        t = rows[0]
        if t.get("status") == "done":
            await self._done(ctx, run_id, run, task_id, st, t.get("result") or {})
        elif t.get("status") == "failed":
            st["state"] = "failed"
            err = str((t.get("result") or {}).get("error", ""))[:200]
            await self._progress(ctx, run, run_id, "creatives_failed",
                                 f"Round {st.get('round', 0)}'s creative task failed: {err}", "error")
        elif t.get("status") == "claimed" and t.get("claimed_by") not in (None, "", "copywriter"):
            await self._on_error(ctx, run_id, run, task_id, st, ApiError("claim_lost"))
        elif t.get("status") == "queued" or (t.get("status") == "claimed"
                                             and t.get("claimed_by") in (None, "", "copywriter")):
            # still ours (or unclaimed): the route joins the in-flight call or resumes the claim
            await self._generate(ctx, run_id, run, task_id, st, tasks)

    async def _done(self, ctx, run_id: str, run: dict, task_id: str, st: dict, res: dict) -> None:
        r = st.get("round", 0)
        st["state"] = "done"
        applied = [str(x) for x in res.get("learning_ids_applied") or st.get("chosen") or []]
        cw = CreativesWritten(
            run_id=run_id, round=r, task_id=task_id, written=int(res.get("written") or 0),
            reused=int(res.get("reused") or 0), ranked=int(res.get("ranked") or 0),
            gated_out=int(res.get("gated_out") or 0),
            creative_ids=[str(x) for x in (res.get("creative_ids") or [])][:60],
            learning_ids_offered=st.get("offered", []), learning_ids_applied=applied,
            next_task=res.get("next_task"))
        gated = f", {cw.gated_out} gated out" if cw.gated_out else ""
        await self._report(ctx, run_id, cw, f"Round {r} creatives: {cw.written} written, "
                                            f"{cw.ranked} ranked; next {cw.next_task or 'none'}")
        await self._progress(ctx, run, run_id, "creatives_written",
                             f"Copywriter wrote {cw.written} ads ({cw.ranked} ranked{gated}) and "
                             f"queued {cw.next_task or 'no further round'}.")
        await self.status.set("working", f"watching {run_id}")

    async def answer(self, ctx, text: str) -> str:
        last = ctx.storage.get("cw:last")
        if not last:
            return ("I'm Ad Lab's Copywriter: after each round I claim the creative task, choose "
                    "which learnings to apply (at most 3 per segment) and write the next round's "
                    "ads. Nothing written yet in this database.")
        tasks = self._tasks(ctx)
        reasons = (tasks.get(last.get("task_id")) or {}).get("reasons") or []
        if last.get("handed_off"):
            return f"Round {last['round']}'s task was handed off to {last.get('claimed_by')}."
        lines = [f"Last task {last['task_id']}: {last.get('written', 0)} ads written, "
                 f"{last.get('ranked', 0)} ranked; applied "
                 f"{len(last.get('learning_ids_applied') or [])} of "
                 f"{len(last.get('learning_ids_offered') or [])} learnings."]
        lines += [f"- {r}" for r in reasons[:8]]
        return "\n".join(lines)


def common_round(task_id: str) -> int:
    m = re.search(r"_r(\d+)$", task_id)
    return int(m.group(1)) if m else 0


def build(hub: Hub, *, offline: bool, port: int | None = None) -> Any:
    from uagents import Protocol

    agent = common.make_agent(SPEC, hub.cfg.seeds["copywriter"], port=port or SPEC.solo_port,
                              offline=offline)
    c = Copywriter(hub, agent.address)
    common.add_chat_inbox(agent, offline)
    run = Protocol(spec=RUN_SPEC, role="copywriter")
    for model in (RunStarted, RunFinished, RunFailed):
        run.on_message(model)(common.typed_to_inbox(model))
    agent.include(run, publish_manifest=not offline)

    @agent.on_event("startup")
    async def _startup(ctx):
        await c.status.set("idle", "online")
        await hub.api.warm_generate()

    @agent.on_interval(min(1.0, hub.cfg.poll_s))
    async def _work(ctx):
        await c.tick(ctx)

    @agent.on_interval(60)
    async def _heartbeat(ctx):
        await c.status.heartbeat()

    agent._adlab = c
    return agent
