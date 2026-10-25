"""Headless end-to-end check of the four agents plus a fake ASI:One user, in one offline Bureau.

  python agents/e2e.py --fake-api --rounds 2            no server needed (FakeApi task board)
  python agents/e2e.py --rounds 2                       against ADLAB_API_URL (dev:local + workers)
  python agents/e2e.py --fake-api --approve prose       approve by typing instead of the card

Offline: derived seeds (never the registered agents' addresses), no mailbox, no inspector, the
Almanac status call stubbed, Bureau on port 8010. The fake user asks Ad Lab, approves the recipes
card (a card response by default), pulls "status" after the first leaderboard, and checks the
card sequence, the task board, and that every hop was logged. Exit 0 = all checks passed,
1 = a check failed, 2 = timeout, 3 = the target API isn't a safe test database.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cards  # noqa: E402
import common  # noqa: E402
from common import DATA_DIR, Hub, Peers  # noqa: E402

GOAL = "find ads that beat Magic Spoon's current ones"


class FakeUser:
    def __init__(self, hub: Hub, api: Any, ad_lab: str, args: argparse.Namespace):
        self.hub, self.api, self.ad_lab, self.args = hub, api, ad_lab, args
        self.session = uuid.uuid4()
        self.built_at = time.monotonic()
        self.t0: float | None = None
        self.first_msg_id = ""
        self.ack_at: float | None = None
        self.sent: list[str] = []
        self.events: list[dict] = []
        self.approved_via = ""
        self.status_sent_at: float | None = None
        self.status_answer: dict | None = None
        self.finishing = False

    def now(self) -> float:
        return time.monotonic() - (self.t0 or self.built_at)

    async def send(self, ctx: Any, content: list) -> str:
        from uagents_core.contrib.protocols.chat import ChatMessage

        msg = ChatMessage(content=content)
        await common.send_on_session(ctx, self.ad_lab, msg, self.session, common.chat_digest())
        self.sent.append(str(msg.msg_id))
        return str(msg.msg_id)

    async def tick(self, ctx: Any) -> None:
        from uagents_core.contrib.protocols.chat import StartSessionContent, TextContent

        if self.t0 is None and time.monotonic() - self.built_at >= 1.5:
            self.t0 = time.monotonic()
            self.first_msg_id = await self.send(ctx, [StartSessionContent(), TextContent(GOAL)])
            print(f"[e2e] user -> Ad Lab: {GOAL!r}", flush=True)
        if self.t0 is not None and self.now() > self.args.timeout and not self.finishing:
            print(f"[e2e] TIMEOUT after {self.args.timeout:.0f}s", flush=True)
            await self.finish(ctx, timed_out=True)

    def on_ack(self, msg: Any) -> None:
        if str(msg.acknowledged_msg_id) == self.first_msg_id and self.ack_at is None:
            self.ack_at = self.now()

    async def on_message(self, ctx: Any, msg: Any) -> None:
        from uagents_core.contrib.protocols.chat import (
            EndSessionContent, TextContent)

        text = msg.text()
        found = cards.cards_in(msg)
        ev = {"t": round(self.now(), 2), "text": text,
              "cards": [{"kind": cards.card_kind(c), "title": getattr(c.payload, "title", None),
                         "is_terminal": c.is_terminal, "card_id": str(c.card_id)} for c in found],
              "end_session": any(isinstance(b, EndSessionContent) for b in msg.content)}
        self.events.append(ev)
        first = text.splitlines()[0] if text else ""
        tag = f" [{ev['cards'][0]['kind']}: {ev['cards'][0]['title']}]" if found else ""
        print(f"[e2e] {ev['t']:6.1f}s Ad Lab: {cards.cut(first, 110)}{tag}"
              f"{' [end-session]' if ev['end_session'] else ''}", flush=True)

        if text.startswith(cards.STATUS_PREFIX):
            if self.status_sent_at is not None and self.status_answer is None:
                self.status_answer = {"after_s": self.now() - self.status_sent_at,
                                      "card": bool(found)}
            return
        for card in found:
            title = getattr(card.payload, "title", "") or ""
            if cards.card_kind(card) == "review" and not self.approved_via:
                sel = dict(card.payload.approve_cta.selection)
                if self.args.approve == "card":
                    content = [cards.create_card_response_content(card_id=card.card_id, selection=sel)]
                elif self.args.approve == "json":
                    content = [TextContent(json.dumps(sel))]
                else:
                    content = [TextContent("Start the run")]
                self.approved_via = self.args.approve
                await self.send(ctx, content)
                print(f"[e2e] user approves via {self.args.approve}: {sel}", flush=True)
            if title.startswith(cards.TITLE_ROUND_PREFIX) and self.status_sent_at is None:
                self.status_sent_at = self.now()
                await self.send(ctx, [TextContent("status")])
                print("[e2e] user -> Ad Lab: 'status'", flush=True)
            if title == cards.TITLE_WINNERS and card.is_terminal and ev["end_session"]:
                asyncio.ensure_future(self.finish(ctx))
        if (text.startswith("Run ") and " failed" in text) or "didn't start" in text:
            print("[e2e] the run failed", flush=True)
            asyncio.ensure_future(self.finish(ctx))

    async def finish(self, ctx: Any, timed_out: bool = False) -> None:
        if self.finishing:
            return
        self.finishing = True
        await asyncio.sleep(2.0)  # let trailing hops (RunFinished to the Copywriter) log
        checks = await evaluate(self, timed_out)
        ok = all(c["ok"] for c in checks)
        for c in checks:
            print(f"[e2e] {'PASS' if c['ok'] else 'FAIL'} {c['name']}: {c['detail']}", flush=True)
        report = {"ok": ok, "timed_out": timed_out, "approve": self.args.approve,
                  "rounds": self.args.rounds, "fake_api": self.args.fake_api, "checks": checks,
                  "events": self.events, "log_records": len(self.hub.log_records),
                  "api_calls": len(getattr(self.api, "calls", []))}
        path = DATA_DIR / f"e2e-{self.args.ts}.json"
        try:
            path.write_text(json.dumps(report, indent=2, default=str))
            print(f"[e2e] report: {path}", flush=True)
        except OSError:
            pass
        print(f"[e2e] {'ALL PASS' if ok else 'FAILED'}", flush=True)
        sys.stdout.flush()
        os._exit(2 if timed_out else (0 if ok else 1))


def _check(name: str, ok: bool, detail: str) -> dict:
    return {"name": name, "ok": bool(ok), "detail": detail}


async def evaluate(fu: FakeUser, timed_out: bool) -> list[dict]:
    R = fu.args.rounds
    hub, api = fu.hub, fu.api
    out: list[dict] = []
    out.append(_check("A1 ack", fu.ack_at is not None and fu.ack_at <= 5.0,
                      f"first message acked after {fu.ack_at if fu.ack_at is None else round(fu.ack_at, 2)}s"))

    seq = [e for e in fu.events if e["cards"] and not e["text"].startswith(cards.STATUS_PREFIX)]
    cs = [e["cards"][0] for e in seq]
    exp_len = 3 + (R + 1) + 1
    ok = len(cs) == exp_len
    detail = [f"{c['kind']}:{c['title']}" for c in cs]
    if ok:
        first_two = {(cs[0]["kind"], cs[0]["title"].endswith(cards.TITLE_BRAND_SUFFIX)),
                     (cs[1]["kind"], cs[1]["title"] == cards.TITLE_COMPETITORS)}
        ok &= first_two == {("detail", True), ("carousel", True)}
        ok &= cs[2]["kind"] == "review"
        for i in range(R + 1):
            c = cs[3 + i]
            ok &= (c["kind"] == "detail" and c["is_terminal"]
                   and c["title"].startswith(f"{cards.TITLE_ROUND_PREFIX}{i} of {R}"))
        last = cs[-1]
        ok &= last["kind"] == "carousel" and last["title"] == cards.TITLE_WINNERS and last["is_terminal"]
        ends = [e for e in fu.events if e["end_session"]]
        ok &= len(ends) == 1 and ends[0] is seq[-1]
    out.append(_check("A2 card order", ok, " -> ".join(detail)))

    sa = fu.status_answer
    out.append(_check("A3 status pull", bool(sa and sa["card"] and sa["after_s"] <= 15),
                      f"answered {sa}" if sa else "no answer"))

    run_id = next((r["body"].get("run_id") for r in hub.log_records
                   if r["body"].get("from_agent") == "agt_strategist" and r["body"].get("run_id")), "")
    try:
        st = await api.rounds_status(run_id) if run_id else {}
    except Exception as ex:
        st = {"error": str(ex)}
    tasks = st.get("tasks") or []
    rounds = {r["round"]: r["status"] for r in st.get("rounds") or []}
    run_tasks = [t for t in tasks if t["kind"] == "run_round"]
    gen_tasks = [t for t in tasks if t["kind"] == "generate_creatives"]
    ok = bool(st.get("run")) and st["run"].get("status") == "done"
    ok &= all(rounds.get(r) == "done" for r in range(R + 1))
    ok &= not any(t["status"] == "failed" for t in tasks)
    ok &= len(run_tasks) == R + 1 and all(t["status"] == "done" for t in run_tasks)
    ok &= len(gen_tasks) == R and all(t["status"] == "done" and t["claimed_by"] == "copywriter"
                                      for t in gen_tasks)
    out.append(_check("A4 task board", ok,
                      f"{run_id}: run={(st.get('run') or {}).get('status')} rounds={rounds} "
                      f"gen claimed_by={[t['claimed_by'] for t in gen_tasks]}"))

    ok = len(gen_tasks) == R
    for t in gen_tasks:
        res = t.get("result") or {}
        r = t["payload"].get("round", -1)
        ok &= int(res.get("ranked") or 0) >= 1 and res.get("next_task") == f"tsk_run_{run_id}_r{r + 1}"
    out.append(_check("A5 creative results", ok,
                      f"{[(t['task_id'], (t.get('result') or {}).get('ranked'), (t.get('result') or {}).get('next_task')) for t in gen_tasks]}"))

    good = [r for r in hub.log_records if r["ok"] and r.get("message_id")]
    bad = [r for r in hub.log_records if not r["ok"]]
    logged = Counter((r["body"]["from_agent"], r["body"]["to_agent"], r["body"]["protocol"]) for r in good)
    sends = Counter(hub.sends)
    unlogged = {k: v - logged.get(k, 0) for k, v in sends.items() if logged.get(k, 0) < v}
    need = {("user", "agt_ad_lab", "AgentChatProtocol"): len(fu.sent),
            ("agt_ad_lab", "agt_scout", "AdLabIntel"): 1, ("agt_scout", "agt_ad_lab", "AdLabIntel"): 1,
            ("agt_ad_lab", "agt_strategist", "AdLabPlan"): 1,
            ("agt_strategist", "agt_ad_lab", "AdLabPlan"): 1,
            ("agt_ad_lab", "agt_strategist", "AdLabRun"): 1,
            ("agt_strategist", "agt_copywriter", "AdLabRun"): 2,  # RunStarted + RunFinished
            ("agt_copywriter", "agt_strategist", "AdLabCreatives"): R + 1,  # R rounds + WinnersRendered
            ("agt_strategist", "agt_copywriter", "AdLabCreatives"): 1,  # RenderWinners
            ("agt_strategist", "agt_ad_lab", "AdLabRun"): (R + 1) + 2,  # RunStarted, R+1 results, finish
            ("agt_ad_lab", "user", "AgentChatProtocol"): 5}
    short = {k: (logged.get(k, 0), v) for k, v in need.items() if logged.get(k, 0) < v}
    with_cards = sum(1 for r in good if r["body"]["from_agent"] == "agt_ad_lab"
                     and r["body"]["payload"].get("card_kind"))
    ok = not bad and not unlogged and not short and with_cards >= 5
    out.append(_check("A6 every hop logged", ok,
                      f"{len(good)} logged ok, {len(bad)} failed{(' ' + bad[0]['error']) if bad else ''}; "
                      f"unlogged sends={unlogged}; short={short}; ad_lab cards logged={with_cards}"))

    sizes_ok = all(len(r["body"]["summary"]) <= 140 and "\n" not in r["body"]["summary"]
                   and len(json.dumps(r["body"]["payload"]).encode()) <= 4096 for r in hub.log_records)
    out.append(_check("A7 summary and payload limits", sizes_ok, "summary <= 140, payload <= 4096 bytes"))

    calls = [c for c in getattr(api, "calls", []) if c[1] == "/ingest/refresh"]
    dry_plan = any("dry" in c[2] for c in calls)
    execute = any("targets" in c[2] for c in calls)
    detail = f"plan(dry)={dry_plan} execute(targets)={execute}"
    ok = dry_plan
    if hasattr(api, "ingest_calls"):
        ok &= all(c.get("requested_by") == "agt_scout" for c in api.ingest_calls)
        ok &= all(t.get("kind") in ("page", "source") for c in api.ingest_calls
                  for t in c.get("targets") or [])
        if api.mode == "test":
            ok &= execute and all(j["status"] == "skipped" and j["dry"] for j in api.ingest_jobs)
            detail += f"; jobs={[j['status'] for j in api.ingest_jobs]}"
    out.append(_check("A8 scout refresh", ok, detail))

    if hasattr(api, "status_posts"):
        ids = {p["agent_id"] for p in api.status_posts}
        ok = ids == {"agt_ad_lab", "agt_scout", "agt_strategist", "agt_copywriter"}
        detail = f"{len(api.status_posts)} status posts from {sorted(ids)}"
    else:
        posts = [c for c in api.calls if c[1] == "/log/status" and c[3]]
        ok = len(posts) >= 4
        detail = f"{len(posts)} status posts"
    out.append(_check("A9 agent status rows", ok, detail))

    approvals = [r["body"] for r in good if r["body"]["from_agent"] == "user"
                 and r["body"]["payload"].get("intent") == "go"]
    src = approvals[0]["payload"].get("source") if approvals else None
    expected_src = {"card": "card", "json": "json", "prose": "prose"}[fu.args.approve]
    out.append(_check("A10 approval parsed", src == expected_src,
                      f"approved via {fu.approved_via}, Ad Lab parsed source={src}"))
    out.append(_check("A11 no timeout", not timed_out, f"finished in {fu.now():.1f}s"))

    # RenderWinners: Strategist -> Copywriter; WinnersRendered: the Copywriter's reply carrying `rendered`.
    renders = [r["body"] for r in good if r["body"]["protocol"] == "AdLabCreatives"
               and (r["body"]["from_agent"] == "agt_strategist" or "rendered" in r["body"]["payload"])]
    kinds = ["RenderWinners" if b["from_agent"] == "agt_strategist" else "WinnersRendered" for b in renders]
    rendered = next((len(b["payload"].get("rendered") or []) for b in renders
                     if b["from_agent"] == "agt_copywriter"), 0)
    out.append(_check("A12 winners rendered with the product photo",
                      kinds == ["RenderWinners", "WinnersRendered"] and rendered >= 1,
                      f"hops={kinds}, rendered={rendered}"))
    return out


def build_fake_user(fu: FakeUser, port: int) -> Any:
    from uagents import Agent, Protocol
    from uagents_core.contrib.protocols.chat import (
        ChatAcknowledgement, ChatMessage, chat_protocol_spec)

    agent = Agent(name="E2E User", seed=f"adlab-e2e-user-{uuid.uuid4().hex}", port=port,
                  mailbox=False, enable_agent_inspector=False, publish_agent_details=False,
                  mark_inactive_on_shutdown=False)

    async def _no_almanac_status(active: bool) -> None:
        return None

    agent._update_agent_status = _no_almanac_status
    proto = Protocol(spec=chat_protocol_spec)

    @proto.on_message(ChatMessage)
    async def _on_msg(ctx, sender, msg):
        await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))
        await fu.on_message(ctx, msg)

    @proto.on_message(ChatAcknowledgement)
    async def _on_ack(ctx, sender, msg):
        fu.on_ack(msg)

    agent.include(proto, publish_manifest=False)

    @agent.on_interval(0.5)
    async def _tick(ctx):
        await fu.tick(ctx)

    return agent


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Ad Lab agents: headless end-to-end check")
    ap.add_argument("--fake-api", action="store_true", help="use the in-memory FakeApi")
    ap.add_argument("--rounds", type=int, default=2)
    ap.add_argument("--approve", choices=["card", "json", "prose"], default="card")
    ap.add_argument("--prose", action="store_true", help="same as --approve prose")
    ap.add_argument("--timeout", type=float, default=None)
    ap.add_argument("--port", type=int, default=8010)
    ap.add_argument("--brand-kit", metavar="IMAGE", default=None,
                    help="real API only: save the brand kit (magicspoon.com + this product photo) "
                         "through POST /api/brand-kit first; else the database must already have one")
    ap.add_argument("--allow-remote", action="store_true",
                    help="allow a non-local API target when its db_name is adlab-live")
    args = ap.parse_args(argv)
    if args.prose:
        args.approve = "prose"
    args.rounds = max(1, min(5, args.rounds))
    args.timeout = args.timeout or (120.0 if args.fake_api else 1500.0)
    args.ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)  # the agents and the Bureau pick this loop up

    cfg = common.load_config(derived=True, offline=True)
    cfg.rounds_planned = args.rounds
    if args.fake_api:
        from fake_api import FakeApi

        api: Any = FakeApi(step_s=0.3, gen_delay_s=0.2)
        cfg.worker_s, cfg.scout_s, cfg.strategist_s, cfg.watch_s, cfg.poll_s = 0.2, 0.3, 0.3, 0.3, 0.3
        health = loop.run_until_complete(api.health())
    else:
        import httpx

        api = common.Api(cfg.api_url)
        try:
            health = httpx.get(f"{cfg.api_url}/health", timeout=15).json().get("data") or {}
        except Exception as ex:
            print(f"[e2e] can't reach {cfg.api_url}/health: {ex}", file=sys.stderr)
            return 3
        problems = []
        if health.get("mode") != "test":
            problems.append(f"mode is {health.get('mode')!r}, not 'test'")
        if not health.get("runs_allowed"):
            problems.append(f"runs are not allowed on {health.get('db_name')}")
        if not health.get("run_slot_free"):
            problems.append(f"{health.get('db_name')} already holds a run; reset it first "
                            "(npm run bench:reset:local)")
        if not health.get("is_local") and not (args.allow_remote and health.get("db_name") == "adlab-live"):
            problems.append(f"{health.get('db_name')} is not local (use --allow-remote for adlab-live)")
        if not problems and args.brand_kit:
            with open(args.brand_kit, "rb") as f:
                saved = httpx.post(f"{common.app_url(cfg.api_url)}/api/brand-kit", timeout=60,
                                   data={"url": "https://magicspoon.com/"},
                                   files={"image": (os.path.basename(args.brand_kit), f)}).json()
            if not saved.get("ok"):
                problems.append(f"saving the brand kit failed: {saved.get('error')}")
        if not problems:
            kit = httpx.get(f"{cfg.api_url}/brand-kit", timeout=15).json().get("data") or {}
            if not kit.get("ready"):
                problems.append(f"no brand kit ({kit.get('reason') or 'GET /brand-kit failed'}): pass "
                                "--brand-kit <product photo>")
        if problems:
            print("[e2e] refusing: " + "; ".join(problems), file=sys.stderr)
            return 3
    db_name = str(health.get("db_name") or "unknown")
    state_dir = DATA_DIR / f"{db_name}-e2e-{args.ts}"
    state_dir.mkdir(parents=True, exist_ok=True)
    os.chdir(state_dir)
    print(f"[e2e] target {db_name} ({'FakeApi' if args.fake_api else cfg.api_url}), rounds={args.rounds}, "
          f"approve={args.approve}, state={state_dir}", flush=True)

    from run_all import build_all
    from uagents import Bureau

    hub = Hub(cfg, api, Peers(cfg))
    agents = build_all(hub, offline=True)
    fu = FakeUser(hub, api, agents["ad_lab"].address, args)
    user = build_fake_user(fu, args.port)
    Bureau(agents=[*agents.values(), user], port=args.port, loop=loop).run()
    return 2  # only reached if the Bureau stops before the user finishes


if __name__ == "__main__":
    sys.exit(main())
