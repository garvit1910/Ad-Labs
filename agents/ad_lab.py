"""Ad Lab: the ASI:One-facing orchestrator.

The chat handler acknowledges every ChatMessage at once and hands it to the inbox; typed
handlers (IntelReport, Progress, RecipePlan, RunStarted, RoundResult, RunFinished, RunFailed)
do the same. One worker interval owns all session state and does the rest: it routes the user's
intent, delegates to Scout and Strategist, turns each hop into a one-line progress message and
posts the five cards. Every reply goes out on the sender's latest inbound session with the chat
protocol digest. EndSessionContent is sent only with the final winners card.
"""

from __future__ import annotations

import uuid
from typing import Any

import cards
import common
from common import AGENT_SPECS, Hub, StatusReporter, clip, log_body, utcnow
from protocols import (
    INTEL_SPEC, P_CHAT, P_INTEL, P_PLAN, P_RUN, PLAN_SPEC, PROGRESS_SPEC, RUN_SPEC, IntelReport,
    IntelRequest, PlanRequest, Progress, RecipePlan, RoundResult, RunFailed, RunFinished,
    RunStarted, StartRun)
from strategist import RESET_HINT, rounds_from_text

SPEC = AGENT_SPECS["ad_lab"]
ACTIVE = {"gathering", "planning", "starting", "running"}
STALE_STEP_S = 300  # a gathering/planning step whose reply never came is re-issued after this
NEW_RUN_HINT = "For a new run, reset the database (npm run bench:reset:local), then say **new run**."
GOAL_EXAMPLE = "find ads that beat Magic Spoon's current ones"
HELP = ("I'm Ad Lab. I test Magic Spoon ad recipes on 300 simulated shoppers with three helper "
        "agents: Scout (brand and competitor intel), Strategist (recipes, rounds and winners) and "
        "Copywriter (new ads between rounds).")


def new_session(sender: str, session: str) -> dict:
    return {"sender": sender, "session": session, "request_id": "", "state": "idle", "goal": "",
            "plan": None, "plan_id": "", "run_id": "", "rounds_planned": 0, "cards": {},
            "last_card_key": "", "last_line": "", "posted": [], "winners": {}, "recent": {}}


def hint(sess: dict) -> str:
    s = sess.get("state", "idle")
    if s == "awaiting_go":
        return f"Say **go** (or tap Start the run) to start {sess.get('run_id')}, or **not now**."
    if s == "cancelled":
        return "The recipes stay ready: say **go** when you want to run them."
    if s in ("gathering", "planning", "starting", "running"):
        return "Say **status** for the latest card."
    if s == "done":
        return f"{sess.get('run_id')} is done; each database holds one run. {NEW_RUN_HINT}"
    return f'Say "{GOAL_EXAMPLE}" to start.'


class AdLab:
    def __init__(self, hub: Hub, address: str):
        self.hub = hub
        self.status = StatusReporter(hub, SPEC, address)

    # -- state (single writer: the worker interval) --
    def _load(self, ctx) -> dict:
        st = ctx.storage.get("adlab:state") or {}
        for k, v in (("sessions", {}), ("req", {}), ("run", {}), ("seen", [])):
            st.setdefault(k, v)
        return st

    def _sess(self, st: dict, request_id: str = "", run_id: str = "") -> dict | None:
        sender = st["req"].get(request_id) if request_id else None
        if sender is None and run_id:
            sender = st["run"].get(run_id)
        return st["sessions"].get(sender) if sender else None

    async def tick(self, ctx) -> None:
        st = None
        for item in common.inbox_take(ctx.storage):
            if st is None:
                st = self._load(ctx)
            try:
                await self.handle(ctx, st, item)
            except Exception as ex:
                ctx.logger.exception(f"ad lab item failed: {ex}")
            ctx.storage.set("adlab:state", st)

    async def handle(self, ctx, st: dict, item: dict) -> None:
        t = item.get("t")
        if t == "chat":
            return await self.on_chat(ctx, st, item)
        data = item.get("data") or {}
        handlers = {"IntelReport": self.on_intel, "Progress": self.on_progress,
                    "RecipePlan": self.on_plan, "RunStarted": self.on_started,
                    "RoundResult": self.on_round, "RunFinished": self.on_finished,
                    "RunFailed": self.on_failed}
        if t in handlers:
            await handlers[t](ctx, st, data)

    # -- sending --
    async def say(self, ctx, sess: dict, text: str, *, kind: str = "progress",
                  remember: bool = True) -> None:
        if remember:
            sess["last_line"] = clip(text, 300)
        await common.send_chat(self.hub, ctx, sess["sender"], text, session=sess["session"],
                               kind=kind, run_id=sess.get("run_id", ""))

    async def post_card(self, ctx, sess: dict, key: str, card: cards.CardOut, *,
                        end_session: bool = False) -> None:
        if key in sess["posted"]:
            return
        sess["posted"].append(key)
        sess["cards"][key] = card.to_dict()
        sess["last_card_key"] = key
        await common.send_chat(self.hub, ctx, sess["sender"], card.text, card=card,
                               end_session=end_session, session=sess["session"], kind="result",
                               run_id=sess.get("run_id", ""), summary=f"Card: {card.title}")

    async def _set_state(self, sess: dict, state: str, step: str, status: str = "working") -> None:
        sess["state"] = state
        sess["state_since"] = utcnow().timestamp()
        await self.status.set(status, step)

    # -- chat --
    async def on_chat(self, ctx, st: dict, item: dict) -> None:
        msg_id = item.get("msg_id", "")
        if msg_id and msg_id in st["seen"]:
            return  # mailbox redelivery
        st["seen"] = (st["seen"] + [msg_id])[-200:]
        msg = common.parse_chat(item)
        sender = item["sender"]
        sess = st["sessions"].get(sender) or new_session(sender, item.get("session", ""))
        sess["session"] = item.get("session", "")  # always reply on the latest inbound session
        st["sessions"][sender] = sess
        ui = cards.parse_user_input(msg)
        has_input = bool(ui.raw) or ui.source == "card"
        shown = ui.raw or f"[card] {ui.intent} {ui.args}"
        await self.hub.log(log_body("user", SPEC.agent_id, P_CHAT, "request", shown,
                                    {"text": ui.raw[:1500], "intent": ui.intent, "args": ui.args,
                                     "source": ui.source}, sess.get("run_id", "")), ctx.logger)
        if not has_input:
            return  # start/end-session markers only
        await self.route(ctx, st, sess, ui)

    async def route(self, ctx, st: dict, sess: dict, ui: cards.UserInput) -> None:
        s, i = sess["state"], ui.intent
        if i == "status":
            return await self.status_reply(ctx, sess)
        if i == "show_card":
            return await self.show_card(ctx, sess, ui.args.get("card", ""))
        if i == "show_ad":
            return await self.show_ad(ctx, sess, ui.args.get("creative_id", ""))
        if i == "help":
            return await self.say(ctx, sess, f"{HELP} {hint(sess)}", kind="reply", remember=False)
        if i in ("request", "retry", "replan") and s in ("gathering", "planning") \
                and utcnow().timestamp() - float(sess.get("state_since") or 0) > STALE_STEP_S:
            return await self.resume_step(ctx, st, sess)
        if i == "retry" and s == "done":
            return await self.new_run_after_done(ctx, st, sess)
        if i == "retry":
            return await self.say(ctx, sess, f"Each database holds one run, so a new run needs a "
                                  f"fresh database. {RESET_HINT}", kind="reply", remember=False)
        if i == "replan":
            if sess.get("request_id") and s in ("awaiting_go", "cancelled", "failed"):
                return await self.ask_plan(ctx, sess, "Asked Strategist to check again.")
            return await self.say(ctx, sess, hint(sess), kind="reply", remember=False)
        if i == "cancel":
            if s == "awaiting_go":
                await self._set_state(sess, "cancelled", "recipes on hold", "idle")
                return await self.say(ctx, sess, "OK, the recipes stay ready. Say **go** when you "
                                      "want to run them.", kind="reply")
            if s in ("starting", "running"):
                return await self.say(ctx, sess, f"A started run can't be stopped from chat; "
                                      f"{sess.get('run_id')} ends after {sess.get('rounds_planned')} "
                                      "rounds. Say **status** for the latest card.", kind="reply",
                                      remember=False)
            return await self.say(ctx, sess, f"Nothing to cancel. {hint(sess)}", kind="reply",
                                  remember=False)
        if i == "go":
            if s in ("awaiting_go", "cancelled"):
                return await self.start(ctx, st, sess, ui)
            if s in ("starting", "running"):
                return await self.say(ctx, sess, f"{sess.get('run_id')} is already running. Say "
                                      "**status** for the latest card.", kind="reply", remember=False)
            if s in ("gathering", "planning"):
                return await self.say(ctx, sess, f"Still preparing the recipes ({sess.get('last_line')}).",
                                      kind="reply", remember=False)
            if s == "done":
                return await self.say(ctx, sess, f"{sess.get('run_id')} is done. Each database holds "
                                      f"one run. {NEW_RUN_HINT}", kind="reply", remember=False)
            return await self.begin(ctx, st, sess, ui.raw or GOAL_EXAMPLE)
        if i == "request":
            if s == "done":  # a follow-up ("Which ads won?", "See full ad"): never a new run
                low = (ui.raw or "").lower()
                cid = next((c for c in sess.get("winners") or {} if c.lower() in low), "")
                if cid:
                    return await self.show_ad(ctx, sess, cid)
                return await self.status_reply(ctx, sess, extra=NEW_RUN_HINT)
            if s in ACTIVE:
                return await self.say(ctx, sess, f"A run is already going ({sess.get('last_line')}). "
                                      "Say **status**.", kind="reply", remember=False)
            if s == "awaiting_go":
                return await self.say(ctx, sess, f"The recipes are ready. {hint(sess)}", kind="reply",
                                      remember=False)
            return await self.begin(ctx, st, sess, ui.raw)
        return await self.say(ctx, sess, f"{HELP} {hint(sess)}", kind="reply", remember=False)

    async def begin(self, ctx, st: dict, sess: dict, goal: str) -> None:
        request_id = "req_" + uuid.uuid4().hex[:10]
        st["req"][request_id] = sess["sender"]
        sess.update(request_id=request_id, goal=goal, plan=None, plan_id="", run_id="",
                    rounds_planned=0, cards={}, posted=[], last_card_key="", winners={})
        await self._set_state(sess, "gathering", "asking Scout for brand and competitor intel")
        await self.say(ctx, sess, "On it. Scout is checking which competitor pages and review "
                       "sources are stale; I'll post the brand profile and competitor winners next.",
                       kind="reply")
        await common.send_logged(self.hub, ctx, self.hub.peers.address("agt_scout"),
                                 IntelRequest(request_id=request_id, goal=clip(goal, 500)),
                                 protocol=P_INTEL, kind="request",
                                 summary=f"Intel request: {goal}")

    async def resume_step(self, ctx, st: dict, sess: dict) -> None:
        """Scout's or Strategist's reply never came (for example after a restart mid-step):
        re-issue the step."""
        if sess["state"] == "planning" and sess.get("request_id"):
            return await self.ask_plan(ctx, sess, "Strategist's plan never came back, so I'm "
                                       "picking it up again: asked Strategist for the plan.")
        await self.say(ctx, sess, "Scout's intel never came back, so I'm picking it up again.",
                       kind="reply", remember=False)
        await self.begin(ctx, st, sess, sess.get("goal") or GOAL_EXAMPLE)

    async def new_run_after_done(self, ctx, st: dict, sess: dict) -> None:
        """After a finished run, "new run" starts over only once the database has a free run slot
        (it was reset); otherwise it explains the reset."""
        try:
            health = await self.hub.api.health() or {}
        except Exception:
            health = {}
        if health.get("runs_allowed") and health.get("run_slot_free"):
            return await self.begin(ctx, st, sess, sess.get("goal") or GOAL_EXAMPLE)
        await self.say(ctx, sess, f"{sess.get('run_id')} is done and the database still holds it. "
                       f"{NEW_RUN_HINT}", kind="reply", remember=False)

    async def ask_plan(self, ctx, sess: dict, line: str) -> None:
        await self._set_state(sess, "planning", "waiting for Strategist's plan")
        req = PlanRequest(request_id=sess["request_id"], goal=clip(sess.get("goal", ""), 500),
                          rounds_hint=rounds_from_text(sess.get("goal", "")))
        await common.send_logged(self.hub, ctx, self.hub.peers.address("agt_strategist"), req,
                                 protocol=P_PLAN, kind="request",
                                 summary=f"Plan request: {sess.get('goal', '')}")
        await self.say(ctx, sess, line)

    async def start(self, ctx, st: dict, sess: dict, ui: cards.UserInput) -> None:
        plan = sess.get("plan") or {}
        wanted = ui.args.get("plan_id")
        if wanted and wanted != sess.get("plan_id"):
            return await self.say(ctx, sess, f"That card is from an older plan; the current one is "
                                  f"{sess.get('plan_id')}. {hint(sess)}", kind="reply", remember=False)
        if plan.get("blocked_reason"):
            return await self.say(ctx, sess, f"The run is blocked: {plan['blocked_reason']} Say "
                                  "**check again** once it's fixed.", kind="reply", remember=False)
        run_id = plan.get("run_id", "")
        st["run"][run_id] = sess["sender"]
        await self._set_state(sess, "starting", f"starting {run_id}")
        req = StartRun(request_id=sess["request_id"], plan_id=sess["plan_id"], run_id=run_id,
                       rounds_planned=int(plan.get("rounds_planned") or 1), requested_by="user")
        await common.send_logged(self.hub, ctx, self.hub.peers.address("agt_strategist"), req,
                                 protocol=P_RUN, kind="request",
                                 summary=f"User approved {sess['plan_id']}: start {run_id} "
                                         f"({req.rounds_planned} rounds)", run_id=run_id)
        await self.say(ctx, sess, f"Starting {run_id}: {req.rounds_planned} rounds after the "
                       "warm-up, 300 shoppers.", kind="reply")

    async def status_reply(self, ctx, sess: dict, extra: str = "") -> None:
        line = sess.get("last_line") or "nothing has happened yet"
        key = sess.get("last_card_key")
        if key and key in sess.get("cards", {}):
            card = cards.CardOut.from_dict(sess["cards"][key])
            text = f"{cards.STATUS_PREFIX} {line}\n\n{card.text}" + (f"\n\n{extra}" if extra else "")
            await common.send_chat(self.hub, ctx, sess["sender"], text, card=card,
                                   session=sess["session"], kind="reply",
                                   run_id=sess.get("run_id", ""), summary=f"Status: {line}")
        else:
            await common.send_chat(self.hub, ctx, sess["sender"],
                                   f"{cards.STATUS_PREFIX} {line}. {hint(sess)}",
                                   session=sess["session"], kind="reply",
                                   run_id=sess.get("run_id", ""))

    async def show_card(self, ctx, sess: dict, name: str) -> None:
        key = f"recipes:{sess.get('plan_id')}" if name == "recipes" else name
        if key in sess.get("cards", {}):
            card = cards.CardOut.from_dict(sess["cards"][key])
            await common.send_chat(self.hub, ctx, sess["sender"], card.text, card=card,
                                   session=sess["session"], kind="reply",
                                   run_id=sess.get("run_id", ""), summary=f"Card again: {card.title}")
        else:
            await self.say(ctx, sess, f"The {name or 'requested'} card isn't ready yet. {hint(sess)}",
                           kind="reply", remember=False)

    async def show_ad(self, ctx, sess: dict, creative_id: str) -> None:
        w = sess.get("winners", {}).get(creative_id)
        if not w:
            return await self.say(ctx, sess, "I don't have that ad. The winners card lists them "
                                  "once the run is done.", kind="reply", remember=False)
        await self.say(ctx, sess, f"**{w['segment_name']}** ({w['recipe']})\n"
                       f"Headline: {w['headline']}\nPrimary text: {w['primary_text']}\n"
                       f"CTA: {w.get('cta') or '-'}\nVisual: {w['visual_description']}",
                       kind="reply", remember=False)

    # -- typed messages from the other agents --
    def _drop(self, ctx, what: str, key: str) -> None:
        ctx.logger.warning(f"{what} for unknown session {key}; dropped")

    async def on_intel(self, ctx, st: dict, data: dict) -> None:
        rep = IntelReport.parse_obj(data)
        sess = self._sess(st, rep.request_id)
        if not sess or sess.get("request_id") != rep.request_id:
            return self._drop(ctx, "IntelReport", rep.request_id)
        await self.post_card(ctx, sess, "brand", cards.brand_card(rep))
        comp = cards.competitors_card(rep)
        if comp is not None:
            await self.post_card(ctx, sess, "competitors", comp)
        else:
            await self.say(ctx, sess, "Scout found no competitor winners on file.")
        await self.ask_plan(ctx, sess, "Asked Strategist for a test plan: recipes built from the "
                            "competitor winners and the customers' pains.")

    async def on_progress(self, ctx, st: dict, data: dict) -> None:
        p = Progress.parse_obj(data)
        sess = self._sess(st, p.request_id, p.run_id)
        if not sess:
            return self._drop(ctx, "Progress", p.request_id or p.run_id)
        text = ("Problem: " if p.level == "error" else "") + p.text
        now = utcnow().timestamp()
        recent = {k: v for k, v in (sess.get("recent") or {}).items() if now - v < 60}
        if text in recent:
            return
        recent[text] = now
        sess["recent"] = recent
        await self.say(ctx, sess, text)

    async def on_plan(self, ctx, st: dict, data: dict) -> None:
        plan = RecipePlan.parse_obj(data)
        sess = self._sess(st, plan.request_id)
        if not sess or sess.get("request_id") != plan.request_id:
            return self._drop(ctx, "RecipePlan", plan.request_id)
        sess.update(plan=data, plan_id=plan.plan_id, run_id=plan.run_id,
                    rounds_planned=plan.rounds_planned)
        sess["last_line"] = (f"Recipes ready for {plan.run_id}" if not plan.blocked_reason
                             else f"Recipes ready, but blocked: {plan.blocked_reason}")
        await self.post_card(ctx, sess, f"recipes:{plan.plan_id}", cards.recipes_card(plan))
        await self._set_state(sess, "awaiting_go", "waiting for the user's go", "idle")

    async def on_started(self, ctx, st: dict, data: dict) -> None:
        m = RunStarted.parse_obj(data)
        sess = self._sess(st, m.request_id, m.run_id)
        if not sess:
            return self._drop(ctx, "RunStarted", m.run_id)
        st["run"][m.run_id] = sess["sender"]
        sess.update(run_id=m.run_id, rounds_planned=m.rounds_planned)
        await self._set_state(sess, "running", f"relaying {m.run_id}")
        await self.say(ctx, sess, f"Strategist queued round 0 of {m.run_id} on the task board "
                       f"({m.db_name}). B's sim worker picks it up next.")

    async def on_round(self, ctx, st: dict, data: dict) -> None:
        rr = RoundResult.parse_obj(data)
        sess = self._sess(st, rr.request_id, rr.run_id)
        if not sess:
            return self._drop(ctx, "RoundResult", rr.run_id)
        sess["last_line"] = (f"Round {rr.round} of {rr.rounds_planned} done: {rr.impressions} "
                             f"impressions, {rr.buys} orders")
        await self.post_card(ctx, sess, f"round:{rr.run_id}:{rr.round}", cards.leaderboard_card(rr))
        for w in rr.winners:
            if w.segment_id in rr.new_winners:
                await self.say(ctx, sess, f"Winner in {w.segment_name or w.segment_id}: {w.recipe}. "
                               f"{clip(w.statement, 200)}")

    async def on_finished(self, ctx, st: dict, data: dict) -> None:
        rf = RunFinished.parse_obj(data)
        sess = self._sess(st, rf.request_id, rf.run_id)
        if not sess:
            return self._drop(ctx, "RunFinished", rf.run_id)
        sess["winners"] = {w.creative_id: {"segment_name": w.segment_name or w.segment_id,
                                           "recipe": w.recipe, "headline": w.headline,
                                           "primary_text": w.primary_text, "cta": w.cta,
                                           "visual_description": w.visual_description}
                           for w in rf.winners if w.creative_id}
        declared = sum(1 for w in rf.winners if w.declared)
        sess["last_line"] = (f"{rf.run_id} is done after {rf.rounds_completed} rounds: {declared} "
                             f"winners, {len(rf.winners) - declared} leaders")
        await self._set_state(sess, "done", f"{rf.run_id} done", "idle")
        card = cards.winners_card(rf)
        if card is not None:
            await self.post_card(ctx, sess, f"winners:{rf.run_id}", card, end_session=True)
        elif f"winners:{rf.run_id}" not in sess["posted"]:
            sess["posted"].append(f"winners:{rf.run_id}")
            await common.send_chat(self.hub, ctx, sess["sender"],
                                   f"{sess['last_line']}. No winners table came back.",
                                   end_session=True, session=sess["session"], kind="result",
                                   run_id=rf.run_id)

    async def on_failed(self, ctx, st: dict, data: dict) -> None:
        m = RunFailed.parse_obj(data)
        sess = self._sess(st, m.request_id, m.run_id)
        if not sess:
            return self._drop(ctx, "RunFailed", m.run_id)
        if m.kind == "start":
            text = f"{m.run_id} didn't start: {clip(m.error, 200)} {m.hint}".strip()
        else:
            text = (f"Run {m.run_id} failed at {m.kind or 'a task'} round {m.round}: "
                    f"{clip(m.error, 200)}. {m.hint}").strip()
        await self._set_state(sess, "failed", f"{m.run_id} failed", "error")
        await self.say(ctx, sess, text, kind="result")


def build(hub: Hub, *, offline: bool, port: int | None = None) -> Any:
    from uagents import Protocol

    agent = common.make_agent(SPEC, hub.cfg.seeds["ad_lab"], port=port or SPEC.solo_port,
                              offline=offline)
    a = AdLab(hub, agent.address)
    common.add_chat_inbox(agent, offline)
    roles = ((INTEL_SPEC, (IntelReport,)), (PROGRESS_SPEC, (Progress,)), (PLAN_SPEC, (RecipePlan,)),
             (RUN_SPEC, (RunStarted, RoundResult, RunFinished, RunFailed)))
    for spec, models in roles:
        proto = Protocol(spec=spec, role="ad_lab")
        for model in models:
            proto.on_message(model)(common.typed_to_inbox(model))
        agent.include(proto, publish_manifest=not offline)

    @agent.on_event("startup")
    async def _startup(ctx):
        if hub.cfg.payment:
            ctx.logger.warning("ADLAB_PAYMENT=1 is set, but the Payment Protocol is cut; ignoring.")
        await a.status.set("idle", "online")

    @agent.on_interval(hub.cfg.worker_s)
    async def _work(ctx):
        await a.tick(ctx)

    @agent.on_interval(60)
    async def _heartbeat(ctx):
        await a.status.heartbeat()

    agent._adlab = a
    return agent
