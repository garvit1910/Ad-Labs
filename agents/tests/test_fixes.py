"""The review fixes: Ad Lab's follow-ups after a run and stale steps, the Strategist's start
recovery and the Copywriter's claim recovery (all offline, against FakeApi)."""

import asyncio
import json
import unittest
import uuid
from unittest import mock

import ad_lab
import cards
import common
import strategist
from common import AGENT_SPECS, ApiError, Config, Hub, Peers, derive_seed, utcnow
from fake_api import FakeApi
from strategist import RESET_HINT, Strategist
from tests.test_logic import RUN, MemStore, StubCtx, make_copywriter, start_run_until_gen_queued
from uagents_core.contrib.protocols.chat import ChatMessage, TextContent

USER = "agent1q" + "u" * 51
CID = f"cr_g2_{RUN}_07_keto_low_carb_v1"
WINNER = {"segment_id": "seg_keto_low_carb", "segment_name": "Keto low carb", "arm_id": "arm_07",
          "recipe": "health × nutrition", "declared": True, "creative_id": CID,
          "headline": "Cereal, minus the carbs", "primary_text": "Crunchy and keto.",
          "cta": "Shop now", "visual_description": "A bowl on a counter."}


def make_hub(api):
    cfg = Config(seeds={k: derive_seed(k, None) for k in AGENT_SPECS}, offline=True, poll_s=0.0,
                 retry_delays=(0.0, 0.0, 0.0))
    return Hub(cfg, api, Peers(cfg))


def sent_types(ctx):
    return [type(m).__name__ for _, m in ctx.sent]


class InboxRedelivery(unittest.TestCase):
    def test_key_is_removed_only_after_its_item_was_handled(self):
        store = MemStore()
        k1 = common.inbox_put(store, {"n": 1})
        k2 = common.inbox_put(store, {"n": 2})
        it = common.inbox_take(store)
        self.assertEqual(next(it)["n"], 1)
        self.assertIn(k1, store._data)  # still there while it is being handled
        self.assertEqual(next(it)["n"], 2)
        self.assertNotIn(k1, store._data)
        self.assertIn(k2, store._data)  # a restart now redelivers item 2
        self.assertEqual([i["n"] for i in common.inbox_take(store)], [2])
        self.assertEqual(store._data, {})


# --- Ad Lab ---------------------------------------------------------------------------------


class AdLabEnv:
    def __init__(self, api=None):
        self.api = api or FakeApi()
        self.hub = make_hub(self.api)
        addr = self.hub.peers.address("agt_ad_lab")
        self.a = ad_lab.AdLab(self.hub, addr)
        self.ctx = StubCtx(addr)
        self.chats: list = []  # ChatMessages sent to the user

    async def _capture(self, ctx, destination, msg, session, digest):
        self.chats.append(msg)

    def say(self, text):
        msg = ChatMessage(content=[TextContent(text=text)])
        common.inbox_put(self.ctx.storage, {"t": "chat", "sender": USER, "session": str(uuid.uuid4()),
                                            "msg_id": str(msg.msg_id), "msg": msg.json()})

    def sess(self):
        return self.ctx.storage.get("adlab:state")["sessions"][USER]

    def set_sess(self, **fields):
        st = self.a._load(self.ctx)
        sess = st["sessions"].get(USER) or ad_lab.new_session(USER, str(uuid.uuid4()))
        sess.update(fields)
        st["sessions"][USER] = sess
        if sess.get("request_id"):
            st["req"][sess["request_id"]] = USER
        if sess.get("run_id"):
            st["run"][sess["run_id"]] = USER
        self.ctx.storage.set("adlab:state", st)
        return st, sess

    async def finish_run(self):
        st, sess = self.set_sess(state="running", request_id="req_1", run_id=RUN, rounds_planned=2)
        await self.a.on_finished(self.ctx, st, {"request_id": "req_1", "run_id": RUN,
                                                "rounds_completed": 2, "winners": [WINNER]})
        self.ctx.storage.set("adlab:state", st)
        self.chats.clear()
        self.ctx.sent.clear()

    def run(self, coro_fn):
        async def go():
            with mock.patch("common.send_on_session", new=self._capture):
                await coro_fn()
        asyncio.run(go())


class AdLabDoneFollowUps(unittest.TestCase):
    def follow_up(self, text, api=None):
        env = AdLabEnv(api)

        async def go():
            await env.finish_run()
            env.say(text)
            await env.a.tick(env.ctx)
        env.run(go)
        return env

    def test_which_ads_won_resends_winners_card_without_a_new_run(self):
        env = self.follow_up("Which ads won?")
        self.assertNotIn("IntelRequest", sent_types(env.ctx))  # begin() never ran
        sess = env.sess()
        self.assertEqual(sess["state"], "done")
        self.assertIn(CID, sess["winners"])
        self.assertIn(f"winners:{RUN}", sess["posted"])
        self.assertEqual(len(env.chats), 1)
        text = env.chats[0].text()
        self.assertTrue(text.startswith(cards.STATUS_PREFIX))
        self.assertIn(ad_lab.NEW_RUN_HINT, text)
        self.assertEqual([c.payload.title for c in cards.cards_in(env.chats[0])],
                         [cards.TITLE_WINNERS])

    def test_see_full_ad_without_an_id_is_a_status_reply(self):
        env = self.follow_up("See full ad")
        self.assertNotIn("IntelRequest", sent_types(env.ctx))
        self.assertTrue(env.chats[0].text().startswith(cards.STATUS_PREFIX))

    def test_ad_named_in_prose_or_json_reaches_show_ad(self):
        for text in (f"See full ad {CID}", f"full ad {CID} please",
                     json.dumps({"action": "show_ad", "creative_id": CID})):
            env = self.follow_up(text)
            self.assertNotIn("IntelRequest", sent_types(env.ctx))
            self.assertEqual(len(env.chats), 1, text)
            self.assertIn("Headline: Cereal, minus the carbs", env.chats[0].text(), text)
            self.assertEqual(env.sess()["state"], "done")

    def test_new_run_after_done_needs_a_reset(self):
        api = FakeApi()
        api.runs[RUN] = {"run_id": RUN, "status": "done", "rounds_planned": 2}  # slot taken
        env = self.follow_up("new run", api)
        self.assertNotIn("IntelRequest", sent_types(env.ctx))
        self.assertIn(ad_lab.NEW_RUN_HINT, env.chats[0].text())
        env = self.follow_up("new run", FakeApi())  # reset database: free run slot
        self.assertIn("IntelRequest", sent_types(env.ctx))
        self.assertEqual(env.sess()["state"], "gathering")


class AdLabStaleSteps(unittest.TestCase):
    def step(self, state, text, age_s):
        env = AdLabEnv()

        async def go():
            env.set_sess(state=state, request_id="req_old", goal="find ads that beat Magic Spoon",
                         state_since=utcnow().timestamp() - age_s)
            env.say(text)
            await env.a.tick(env.ctx)
        env.run(go)
        return env

    def test_stale_gathering_reissues_the_intel_request(self):
        env = self.step("gathering", "find ads that beat Magic Spoon", ad_lab.STALE_STEP_S + 60)
        self.assertEqual(sent_types(env.ctx), ["IntelRequest"])
        sess = env.sess()
        self.assertEqual(sess["state"], "gathering")
        self.assertNotEqual(sess["request_id"], "req_old")
        self.assertEqual(env.ctx.sent[0][1].request_id, sess["request_id"])
        self.assertIn("picking it up again", env.chats[0].text())

    def test_fresh_gathering_is_left_alone(self):
        env = self.step("gathering", "find ads that beat Magic Spoon", 30)
        self.assertEqual(sent_types(env.ctx), [])
        self.assertEqual(env.sess()["request_id"], "req_old")
        self.assertIn("already going", env.chats[0].text())

    def test_stale_planning_asks_strategist_again(self):
        env = self.step("planning", "check again", ad_lab.STALE_STEP_S + 60)
        self.assertEqual(sent_types(env.ctx), ["PlanRequest"])
        self.assertEqual(env.ctx.sent[0][1].request_id, "req_old")
        self.assertEqual(env.sess()["state"], "planning")
        self.assertIn("picking it up again", env.chats[0].text())

    def test_state_change_records_its_time(self):
        env = AdLabEnv()

        async def go():
            env.say("find ads that beat Magic Spoon")
            await env.a.tick(env.ctx)
        env.run(go)
        self.assertAlmostEqual(env.sess()["state_since"], utcnow().timestamp(), delta=30)


# --- Strategist -----------------------------------------------------------------------------


class StrategistStart(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi(step_s=999)
        self.hub = make_hub(self.api)
        addr = self.hub.peers.address("agt_strategist")
        self.s = Strategist(self.hub, addr)
        self.ctx = StubCtx(addr)
        self.ad_lab = self.hub.peers.address("agt_ad_lab")
        self.copywriter = self.hub.peers.address("agt_copywriter")

    def plan(self) -> dict:
        asyncio.run(self.s.make_plan(self.ctx, {"t": "PlanRequest", "sender": self.ad_lab, "data": {
            "request_id": "req_1", "goal": "2 rounds", "rounds_hint": 2}}))
        self.ctx.sent.clear()
        return list(self.ctx.storage.get("strat:plans").values())[-1]

    def start_item(self, plan):
        return {"t": "StartRun", "sender": self.ad_lab, "data": {
            "request_id": "req_1", "plan_id": plan["plan_id"], "run_id": plan["run_id"],
            "rounds_planned": 2}}

    def to(self, addr, name):
        return [m for a, m in self.ctx.sent if a == addr and type(m).__name__ == name]

    def status_calls(self):
        return sum(1 for c in self.api.calls if c[1] == "/rounds/status")

    def test_timeout_after_the_server_started_is_a_start(self):
        plan = self.plan()
        real = self.api.rounds_start

        async def started_then_timeout(body):
            await real(body)
            raise ApiError("timeout", "POST /rounds/start after 60s")
        self.api.rounds_start = started_then_timeout
        with mock.patch.object(strategist, "START_CHECK_GAP_S", 0):
            asyncio.run(self.s.start_run(self.ctx, self.start_item(plan)))
        rs = self.ctx.storage.get(f"strat:run:{plan['run_id']}")
        self.assertEqual(rs["state"], "watching")
        self.assertEqual(self.ctx.storage.get("strat:active"), plan["run_id"])
        self.assertEqual(len(self.to(self.ad_lab, "RunStarted")), 1)
        self.assertEqual(len(self.to(self.copywriter, "RunStarted")), 1)
        self.assertEqual(self.to(self.ad_lab, "RunFailed"), [])

    def test_timeout_without_a_run_polls_then_fails(self):
        plan = self.plan()

        async def timeout(body):
            raise ApiError("timeout", "POST /rounds/start after 60s")
        self.api.rounds_start = timeout
        with mock.patch.object(strategist, "START_CHECK_GAP_S", 0):
            asyncio.run(self.s.start_run(self.ctx, self.start_item(plan)))
        self.assertEqual(self.status_calls(), strategist.START_CHECK_TRIES)
        self.assertEqual(self.ctx.storage.get(f"strat:run:{plan['run_id']}")["state"], "failed")
        self.assertIsNone(self.ctx.storage.get("strat:active"))
        self.assertEqual(len(self.to(self.ad_lab, "RunFailed")), 1)

    def test_refusal_fails_without_polling(self):
        plan = self.plan()

        async def refuse(body):
            raise ApiError("db_has_run", "adlab-fake already holds a run", 409)
        self.api.rounds_start = refuse
        asyncio.run(self.s.start_run(self.ctx, self.start_item(plan)))
        self.assertEqual(self.status_calls(), 0)
        failed = self.to(self.ad_lab, "RunFailed")
        self.assertTrue(failed and failed[0].hint == RESET_HINT)

    def stale_starting(self, plan, queue_r0: bool):
        run_id = plan["run_id"]
        if queue_r0:
            asyncio.run(self.api.rounds_start({"run_id": run_id, "rounds_planned": 2,
                                               "requested_by": "agt_strategist"}))
        self.ctx.storage.set(f"strat:run:{run_id}", {
            "run_id": run_id, "request_id": "req_1", "plan_id": plan["plan_id"],
            "rounds_planned": 2, "state": "starting", "emitted": [], "declared": [],
            "creatives": {}, "last_warn": {}, "phase": "", "phase_since": 0, "db_name": "adlab-fake"})
        self.ctx.storage.set("strat:active", run_id)
        asyncio.run(self.s.tick(self.ctx))
        return self.ctx.storage.get(f"strat:run:{run_id}")

    def test_stale_starting_with_round0_queued_becomes_watching(self):
        rs = self.stale_starting(self.plan(), queue_r0=True)
        self.assertEqual(rs["state"], "watching")
        self.assertEqual(len(self.to(self.ad_lab, "RunStarted")), 1)
        self.assertEqual(len(self.to(self.copywriter, "RunStarted")), 1)

    def test_stale_starting_without_round0_fails(self):
        rs = self.stale_starting(self.plan(), queue_r0=False)
        self.assertEqual(rs["state"], "failed")
        self.assertIsNone(self.ctx.storage.get("strat:active"))
        failed = self.to(self.ad_lab, "RunFailed")
        self.assertTrue(failed and failed[0].kind == "start" and failed[0].hint == RESET_HINT)
        self.assertEqual(self.to(self.ad_lab, "RunStarted"), [])

    def test_redelivered_start_run_is_not_refused(self):
        plan = self.plan()
        asyncio.run(self.s.start_run(self.ctx, self.start_item(plan)))
        asyncio.run(self.s.start_run(self.ctx, self.start_item(plan)))  # same item again
        self.assertEqual(self.to(self.ad_lab, "RunFailed"), [])
        self.assertEqual(len(self.to(self.ad_lab, "RunStarted")), 2)
        self.assertEqual(len(self.api.runs), 1)


# --- Copywriter -----------------------------------------------------------------------------

GEN = f"tsk_gen_{RUN}_r0"


class CopywriterRecovery(unittest.TestCase):
    def ticks(self, api, n, before=None, between=None):
        async def go():
            hub, cw, ctx = make_copywriter(api)
            await start_run_until_gen_queued(api)
            common.inbox_put(ctx.storage, {"t": "RunStarted", "sender": "x", "data": {
                "request_id": "req_1", "run_id": RUN, "task_id": f"tsk_run_{RUN}_r0",
                "rounds_planned": 2}})
            if before:
                before(ctx)
            for _ in range(n):
                cw._last_poll = 0.0
                await cw.tick(ctx)
                if between:
                    between(ctx)
            return ctx
        return asyncio.run(go())

    @staticmethod
    def due_now(ctx):
        tasks = ctx.storage.get("cw:tasks") or {}
        for st in tasks.values():
            if st.get("state") == "retry_wait":
                st["next_try"] = 0
        ctx.storage.set("cw:tasks", tasks)

    def test_claim_lost_while_still_queued_retries_instead_of_handing_off(self):
        api = FakeApi(step_s=0, gen_delay_s=0)
        real = api.creatives_generate
        calls = []

        async def lost_once(task_id, learning_ids=None, timeout=330.0):
            calls.append(task_id)
            if len(calls) == 1:  # the board row stays queued
                raise ApiError("claim_lost", f"{task_id} is claimed by nobody", 409)
            return await real(task_id, learning_ids, timeout)
        api.creatives_generate = lost_once
        seen = []
        ctx = self.ticks(api, 1, between=lambda c: seen.append(dict(c.storage.get("cw:tasks")[GEN])))
        self.assertEqual((seen[0]["state"], seen[0]["attempts"]), ("retry_wait", 1))
        self.assertGreater(seen[0]["next_try"], utcnow().timestamp() + 5)
        self.assertEqual([m for _, m in ctx.sent if type(m).__name__ == "CreativesWritten"], [])

        api2 = FakeApi(step_s=0, gen_delay_s=0)
        real2, calls2 = api2.creatives_generate, []

        async def lost_once2(task_id, learning_ids=None, timeout=330.0):
            calls2.append(task_id)
            if len(calls2) == 1:
                raise ApiError("claim_lost", "", 409)
            return await real2(task_id, learning_ids, timeout)
        api2.creatives_generate = lost_once2
        ctx = self.ticks(api2, 2, between=self.due_now)
        gen = api2.board[GEN]
        self.assertEqual((gen["status"], gen["claimed_by"]), ("done", "copywriter"))
        cw = [m for _, m in ctx.sent if type(m).__name__ == "CreativesWritten"]
        self.assertTrue(cw and not cw[0].handed_off and cw[0].claimed_by == "copywriter")

    def test_claim_lost_with_no_owner_gives_up_after_the_retries(self):
        api = FakeApi(step_s=0, gen_delay_s=0)

        async def always_lost(task_id, learning_ids=None, timeout=330.0):
            api.generate_calls.append({"task_id": task_id})
            raise ApiError("claim_lost", "", 409)
        api.creatives_generate = always_lost
        ctx = self.ticks(api, 5, between=self.due_now)
        self.assertEqual(len(api.generate_calls), 4)  # first try + 3 retries
        self.assertEqual(len(api.fail_calls), 1)
        self.assertEqual(ctx.storage.get("cw:tasks")[GEN]["state"], "failed")
        self.assertFalse(any(getattr(m, "handed_off", False) for _, m in ctx.sent))

    def test_held_claim_after_a_restart_is_generated_again(self):
        api = FakeApi(step_s=0, gen_delay_s=0)

        def restart_mid_call(ctx):  # the claim is ours and the stored call says 'generating'
            api.board[GEN].update(status="claimed", claimed_by="copywriter")
            ctx.storage.set("cw:tasks", {GEN: {"run_id": RUN, "state": "generating", "attempts": 0,
                                               "offered": [], "round": 0, "chosen": []}})
        ctx = self.ticks(api, 1, before=restart_mid_call)
        self.assertEqual(len(api.generate_calls), 1)
        self.assertEqual((api.board[GEN]["status"], api.board[GEN]["claimed_by"]), ("done", "copywriter"))
        self.assertEqual(ctx.storage.get("cw:tasks")[GEN]["state"], "done")
        self.assertIn("CreativesWritten", sent_types(ctx))

    def test_timeout_then_still_held_calls_the_route_again(self):
        api = FakeApi(step_s=0, gen_delay_s=0)
        real = api.creatives_generate
        states = []

        async def timeout_once(task_id, learning_ids=None, timeout=330.0):
            states.append(ctx_ref[0].storage.get("cw:tasks")[task_id]["state"])
            if len(states) == 1:
                api.board[task_id].update(status="claimed", claimed_by="copywriter")
                raise ApiError("timeout", "POST /creatives/generate after 330s")
            return await real(task_id, learning_ids, timeout)
        api.creatives_generate = timeout_once
        ctx_ref = []
        ctx = self.ticks(api, 2, before=ctx_ref.append)
        self.assertEqual(states, ["generating", "generating"])  # saved before each call
        self.assertEqual(api.board[GEN]["status"], "done")
        self.assertIn("CreativesWritten", sent_types(ctx))


if __name__ == "__main__":
    unittest.main()
