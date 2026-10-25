"""Pure decision logic, size limits, the Copywriter's failure model and the import smoke test."""

import asyncio
import importlib
import json
import logging
import re
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import common
from common import AGENT_SPECS, Config, Hub, Peers, cap_payload, clip, derive_seed
from copywriter import Copywriter, choose_learnings
from fake_api import FakeApi
from scout import pick_refresh_targets
from strategist import derive_phase, make_run_id, plan_blocked_reason, rounds_from_text

NOW = datetime(2026, 10, 25, 7, 0, tzinfo=timezone.utc)
RUN = "run_test_1025_0700"


def iso(seconds_ago: float) -> str:
    return (NOW - timedelta(seconds=seconds_ago)).isoformat().replace("+00:00", "Z")


def task(kind: str, r: int, status: str, claimed_by=None, age: float = 5) -> dict:
    prefix = "tsk_run" if kind == "run_round" else "tsk_gen"
    return {"task_id": f"{prefix}_{RUN}_r{r}", "run_id": RUN, "kind": kind, "status": status,
            "claimed_by": claimed_by, "payload": {"round": r}, "result": None,
            "created_at": iso(age), "updated_at": iso(age)}


def status(run=True, run_status="running", tasks=(), rounds=()) -> dict:
    return {"run": {"run_id": RUN, "status": run_status, "rounds_planned": 2} if run else None,
            "tasks": list(tasks), "rounds": [{"round": r, "status": s} for r, s in rounds]}


class DerivePhase(unittest.TestCase):
    def phase(self, st, R=2):
        return derive_phase(st, NOW, R, RUN)

    def test_lost(self):
        self.assertEqual(self.phase(status(run=False))["name"], "lost")

    def test_waiting_for_worker_with_age(self):
        p = self.phase(status(tasks=[task("run_round", 0, "queued", age=90)]))
        self.assertEqual((p["name"], p["round"]), ("waiting_for_worker", 0))
        self.assertGreaterEqual(p["age_s"], 89)

    def test_calibrating(self):
        p = self.phase(status(run_status="calibrating", tasks=[task("run_round", 0, "claimed", "sim-worker:x")]))
        self.assertEqual(p["name"], "calibrating")

    def test_round_running(self):
        st = status(tasks=[task("run_round", 0, "done"), task("generate_creatives", 0, "done", "copywriter"),
                           task("run_round", 1, "claimed", "sim-worker:x")], rounds=[(0, "done"), (1, "running")])
        self.assertEqual((self.phase(st)["name"], self.phase(st)["round"]), ("round_running", 1))

    def test_waiting_for_bandit(self):
        st = status(tasks=[task("run_round", 0, "done")], rounds=[(0, "done")])
        self.assertEqual(self.phase(st)["name"], "waiting_for_bandit")

    def test_creatives_queued(self):
        st = status(tasks=[task("run_round", 0, "done"), task("generate_creatives", 0, "queued")],
                    rounds=[(0, "done")])
        self.assertEqual(self.phase(st)["name"], "creatives_queued")

    def test_writing_creatives(self):
        st = status(tasks=[task("run_round", 0, "done"),
                           task("generate_creatives", 0, "claimed", "copywriter")], rounds=[(0, "done")])
        p = self.phase(st)
        self.assertEqual((p["name"], p["claimed_by"]), ("writing_creatives", "copywriter"))

    def test_next_round_waiting_after_gen_done(self):
        st = status(tasks=[task("run_round", 0, "done"), task("generate_creatives", 0, "done", "copywriter")],
                    rounds=[(0, "done")])
        self.assertEqual((self.phase(st)["name"], self.phase(st)["round"]), ("waiting_for_worker", 1))

    def test_done(self):
        st = status(run_status="done", tasks=[task("run_round", 2, "done")], rounds=[(2, "done")])
        self.assertEqual(self.phase(st)["name"], "done")

    def test_failed_wins(self):
        st = status(run_status="done", tasks=[task("run_round", 0, "done"),
                                              task("generate_creatives", 0, "failed", "copywriter")])
        p = self.phase(st)
        self.assertEqual((p["name"], p["task_id"]), ("failed", f"tsk_gen_{RUN}_r0"))


def learning(lid, seg, kind, directive, arm=None, frm=1, to=None, name="Keto"):
    return {"learning_id": lid, "segment_id": seg, "segment_name": name, "arm_id": arm,
            "kind": kind, "statement": "s", "directive": directive, "valid_from_round": frm,
            "valid_to_round": to}


class ChooseLearnings(unittest.TestCase):
    PAYLOAD = {"arms": [{"arm_id": "arm_07", "segment_ids": ["seg_keto", "seg_deal"]},
                        {"arm_id": "arm_11", "segment_ids": ["seg_taste"]}],
               "learning_ids": ["w07", "cd1", "ob1", "ob_old", "digit", "dup", "w02", "closed",
                                "deal1", "taste1"]}
    LEARNINGS = [
        learning("ob_old", "seg_keto", "objection", "Address price early.", frm=1),
        learning("cd1", "seg_keto", "claim_doubt", "Back the protein claim with a fact."),
        learning("ob1", "seg_keto", "objection", "Address not needing cereal yet.", frm=2),
        learning("digit", "seg_keto", "claim_doubt", "Say 13g protein."),
        learning("dup", "seg_keto", "objection", "address PRICE early."),
        learning("w07", "seg_keto", "winner", "Keep leading with health nutrition.", arm="arm_07"),
        learning("w02", "seg_keto", "winner", "Keep the dietary angle.", arm="arm_02"),
        learning("closed", "seg_keto", "objection", "Old advice.", to=2),
        learning("deal1", "seg_deal", "objection", "Lead with the bundle deal."),
        learning("taste1", "seg_taste", "claim_doubt", "Show the taste test."),
        learning("not_offered", "seg_taste", "objection", "Not in the payload."),
    ]

    def test_rule(self):
        chosen, reasons = choose_learnings(self.PAYLOAD, self.LEARNINGS)
        keto = [x for x in chosen if x in {"w07", "cd1", "ob1", "ob_old", "digit", "dup", "w02", "closed"}]
        self.assertEqual(keto, ["w07", "cd1", "ob1"])  # own arm first, then claim_doubt, then newest objection
        self.assertNotIn("digit", chosen)  # directive with a digit
        self.assertNotIn("w02", chosen)  # another arm's learning
        self.assertNotIn("closed", chosen)  # no longer live
        self.assertNotIn("not_offered", chosen)
        self.assertIn("deal1", chosen)
        self.assertIn("taste1", chosen)
        self.assertEqual(len(reasons), 3)
        self.assertTrue(any("cap 3" in r for r in reasons))

    def test_cap_per_segment(self):
        for cap in (1, 2, 3):
            chosen, _ = choose_learnings(self.PAYLOAD, self.LEARNINGS, cap=cap)
            per_seg = {}
            seg_of = {l["learning_id"]: l["segment_id"] for l in self.LEARNINGS}
            for lid in chosen:
                per_seg[seg_of[lid]] = per_seg.get(seg_of[lid], 0) + 1
            self.assertTrue(all(n <= cap for n in per_seg.values()))

    def test_without_learnings_endpoint_applies_all_offered(self):
        chosen, reasons = choose_learnings(self.PAYLOAD, None)
        self.assertEqual(chosen, self.PAYLOAD["learning_ids"])
        self.assertIn("unavailable", reasons[0])


class Limits(unittest.TestCase):
    def test_cap_payload(self):
        cases = [{"a": "x" * 10_000}, {"t": "×·…" * 3000, "k": list(range(500))},
                 {f"key_{i}": {"nested": "y" * 100} for i in range(200)}, ["not", "a", "dict"] * 2000]
        for payload in cases:
            out = cap_payload(payload)
            self.assertIsInstance(out, dict)
            self.assertLessEqual(len(json.dumps(out).encode()), 4096)
        small = {"a": 1, "b": "ok"}
        self.assertEqual(cap_payload(small), small)

    def test_clip(self):
        long = "line one\nline two\t" + "word " * 100
        out = clip(long)
        self.assertLessEqual(len(out), 140)
        self.assertNotIn("\n", out)
        self.assertTrue(out.endswith("…"))
        self.assertEqual(clip("  short  text "), "short text")
        self.assertLessEqual(len(clip("é" * 500)), 140)


class StrategistHelpers(unittest.TestCase):
    def test_run_id(self):
        rid = make_run_id("test", NOW)
        self.assertEqual(rid, "run_test_1025_0700")
        self.assertRegex(rid, r"^run_[a-z0-9_]{1,40}$")
        self.assertEqual(make_run_id("live", NOW), "run_live_1025_0700")

    def test_rounds_from_text(self):
        self.assertEqual(rounds_from_text("test it for 2 rounds"), 2)
        self.assertEqual(rounds_from_text("three rounds please"), 3)
        self.assertEqual(rounds_from_text("9 rounds"), 5)
        self.assertIsNone(rounds_from_text("find ads that beat Magic Spoon"))

    def test_blocked_reasons(self):
        ok_cb = {"check": {"ok": True}, "round0": {"complete": True, "ranked": 54, "expected": 54}}
        demo = {"db_name": "adlab-calhacks13", "runs_allowed": False, "run_slot_free": True}
        self.assertIn("Runs are disabled on adlab-calhacks13", plan_blocked_reason(demo, ok_cb))
        # even if a misconfigured server said runs are allowed on B's database
        self.assertIn("disabled", plan_blocked_reason({**demo, "runs_allowed": True}, ok_cb))
        used = {"db_name": "adlab-local", "runs_allowed": True, "run_slot_free": False,
                "blocked_reason": "run_l2 exists"}
        self.assertIn("Reset the database first", plan_blocked_reason(used, ok_cb))
        fresh = {"db_name": "adlab-local", "runs_allowed": True, "run_slot_free": True}
        self.assertIn("Contract check failed: x", plan_blocked_reason(
            fresh, {"check": {"ok": False, "failures": ["x"]}, "round0": {"complete": True}}))
        self.assertIn("Round 0 has 50/54", plan_blocked_reason(
            fresh, {"check": {"ok": True}, "round0": {"complete": False, "ranked": 50, "expected": 54}}))
        self.assertEqual(plan_blocked_reason(fresh, ok_cb), "")


class ScoutPicks(unittest.TestCase):
    def test_stalest_first_and_caps(self):
        planned = [
            {"kind": "page", "target": "fresh", "ref_id": "p1", "last_synced_at": iso(1800)},
            {"kind": "page", "target": "old", "ref_id": "p2", "last_synced_at": iso(3600 * 30)},
            {"kind": "page", "target": "never", "ref_id": "p3", "last_synced_at": None},
            {"kind": "page", "target": "older", "ref_id": "p4", "last_synced_at": iso(3600 * 50)},
            {"kind": "source", "target": "src_8h", "ref_id": "s1", "last_synced_at": iso(3600 * 8)},
            {"kind": "source", "target": "src_20h", "ref_id": "s2", "last_synced_at": iso(3600 * 20)},
        ]
        picks = pick_refresh_targets(planned, NOW, max_pages=2, max_sources=2)
        self.assertEqual([p["target"] for p in picks], ["never", "older", "src_20h"])
        self.assertEqual(picks[0]["reason"], "never synced")
        self.assertEqual(pick_refresh_targets([planned[0]], NOW), [])


class MemStore:
    def __init__(self):
        self._data = {}

    def get(self, k):
        return self._data.get(k)

    def set(self, k, v):
        self._data[k] = json.loads(json.dumps(v))

    def remove(self, k):
        self._data.pop(k, None)


class StubCtx:
    def __init__(self, address):
        self.agent = SimpleNamespace(address=address)
        self.storage = MemStore()
        self.logger = logging.getLogger("test")
        self.sent = []

    async def send(self, to, msg):
        self.sent.append((to, msg))


def make_copywriter(api):
    cfg = Config(seeds={k: derive_seed(k, None) for k in AGENT_SPECS}, poll_s=0.0,
                 retry_delays=(0.0, 0.0, 0.0))
    hub = Hub(cfg, api, Peers(cfg))
    addr = hub.peers.address("agt_copywriter")
    return hub, Copywriter(hub, addr), StubCtx(addr)


async def start_run_until_gen_queued(api):
    await api.rounds_start({"run_id": RUN, "rounds_planned": 2, "requested_by": "agt_strategist"})
    for _ in range(3):
        api.step(force=True)
    assert api.board[f"tsk_gen_{RUN}_r0"]["status"] == "queued"


class CopywriterFailureModel(unittest.TestCase):
    def run_ticks(self, api, n):
        async def go():
            hub, cw, ctx = make_copywriter(api)
            await start_run_until_gen_queued(api)
            common.inbox_put(ctx.storage, {"t": "RunStarted", "sender": "x", "data": {
                "request_id": "req_1", "run_id": RUN, "task_id": f"tsk_run_{RUN}_r0",
                "rounds_planned": 2}})
            for _ in range(n):
                cw._last_poll = 0.0
                await cw.tick(ctx)
            return hub, ctx
        return asyncio.run(go())

    def test_success_claims_as_copywriter(self):
        api = FakeApi(step_s=0, gen_delay_s=0)
        hub, ctx = self.run_ticks(api, 1)
        gen = api.board[f"tsk_gen_{RUN}_r0"]
        self.assertEqual((gen["status"], gen["claimed_by"]), ("done", "copywriter"))
        self.assertIn(f"tsk_run_{RUN}_r1", api.board)
        kinds = [type(m).__name__ for _, m in ctx.sent]
        self.assertIn("CreativesWritten", kinds)

    def test_generate_failed_retries_three_times_then_fails(self):
        api = FakeApi(step_s=0, gen_delay_s=0, fail_generate=99)
        hub, ctx = self.run_ticks(api, 6)
        self.assertEqual(len(api.generate_calls), 4)  # first try + 3 retries
        self.assertEqual(len(api.fail_calls), 1)
        self.assertEqual(api.board[f"tsk_gen_{RUN}_r0"]["status"], "failed")
        texts = [m.text for _, m in ctx.sent if type(m).__name__ == "Progress"]
        self.assertEqual(sum("retrying" in t for t in texts), 3)

    def test_claim_lost_hands_off(self):
        api = FakeApi(step_s=0, gen_delay_s=0, claim_lost_on_generate=True)
        hub, ctx = self.run_ticks(api, 3)
        self.assertEqual(len(api.generate_calls), 1)  # doesn't fight
        cw = [m for _, m in ctx.sent if type(m).__name__ == "CreativesWritten"]
        self.assertTrue(cw and cw[0].handed_off and cw[0].claimed_by == "creative_worker")


class FakeApiContract(unittest.TestCase):
    def test_one_run_per_database(self):
        async def go():
            api = FakeApi()
            await api.rounds_start({"run_id": RUN, "rounds_planned": 2, "requested_by": "agt_strategist"})
            with self.assertRaises(common.ApiError) as same:
                await api.rounds_start({"run_id": RUN, "rounds_planned": 2, "requested_by": "agt_strategist"})
            with self.assertRaises(common.ApiError) as other:
                await api.rounds_start({"run_id": "run_other", "rounds_planned": 2,
                                        "requested_by": "agt_strategist"})
            h = await api.health()
            return same.exception.code, other.exception.code, h["run_slot_free"]
        self.assertEqual(asyncio.run(go()), ("run_exists", "db_has_run", False))


class ImportSmoke(unittest.TestCase):
    def test_imports_build_no_agent(self):
        from uagents.dispatch import dispatcher

        for name in ("common", "protocols", "cards", "ad_lab", "scout", "strategist", "copywriter",
                     "fake_api", "run_all", "e2e"):
            importlib.import_module(name)
        self.assertEqual(dispatcher.sinks, {}, "importing a module registered an Agent")

    def test_offline_agent_never_calls_almanac(self):
        import ad_lab
        from uagents.dispatch import dispatcher

        cfg = Config(seeds={k: derive_seed(k, None) for k in AGENT_SPECS}, offline=True)
        hub = Hub(cfg, FakeApi(), Peers(cfg))
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            agent = ad_lab.build(hub, offline=True, port=8099)
            self.assertFalse(agent._use_mailbox)
            self.assertIsNone(loop.run_until_complete(agent._update_agent_status(True)))
            self.assertNotEqual(agent.address, common.address_for_seed("x"))
        finally:
            dispatcher.unregister(agent.address, agent)
            loop.close()
            asyncio.set_event_loop(None)


if __name__ == "__main__":
    unittest.main()
