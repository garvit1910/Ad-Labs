"""In-memory stand-in for app/api/agent, following frozen contract v1, for offline tests and
`e2e.py --fake-api`. Same methods as common.Api. FIXTURE DATA ONLY: the brand, competitor and
recipe rows below are illustrative; the round numbers come from sim/SAMPLE_ROUND_SUMMARY.json.

The task board is simulated: rounds/start queues r0. Each board step (at most one per
`step_s`, driven by the agents' polls of /rounds/status and /tasks) moves the latest run_round
from queued to claimed (round 0 calibrates first), then opens the round row, then marks the
round done and queues tsk_gen_<run>_r<r> while r < rounds_planned. creatives/generate completes
the gen task and queues r+1. The last round marks the run done.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from pathlib import Path
from typing import Any

from common import AGENT_IDS, ApiError, iso

SAMPLE = Path(__file__).resolve().parent.parent / "sim" / "SAMPLE_ROUND_SUMMARY.json"
PARTIES = AGENT_IDS | {"user"}
RUN_ID_RE = re.compile(r"^run_[a-z0-9_]{1,40}$")


def _label(tok: str | None) -> str:
    s = (tok or "").replace("_", " ").strip()
    return s[:1].upper() + s[1:]


def seg_name(segment_id: str) -> str:
    return _label(segment_id.removeprefix("seg_"))


def load_sample() -> dict:
    try:
        return json.loads(SAMPLE.read_text())
    except Exception:
        return {}


class FakeApi:
    def __init__(self, *, step_s: float = 0.4, gen_delay_s: float = 0.2, mode: str = "test",
                 db_name: str = "adlab-fake", runs_allowed: bool = True,
                 fail_generate: int = 0, claim_lost_on_generate: bool = False,
                 brand_kit: bool = True):
        self.step_s = step_s
        self.gen_delay_s = gen_delay_s
        self.mode = mode
        self.db_name = db_name
        self.runs_allowed = runs_allowed
        self.fail_generate = fail_generate
        self.claim_lost_on_generate = claim_lost_on_generate
        self.brand_kit_ready = brand_kit
        self.calls: list[tuple[str, str, list[str], bool]] = []
        self.log_messages: list[dict] = []
        self.status_posts: list[dict] = []
        self.ingest_calls: list[dict] = []
        self.ingest_jobs: list[dict] = []
        self.generate_calls: list[dict] = []
        self.fail_calls: list[dict] = []
        self.runs: dict[str, dict] = {}
        self.board: dict[str, dict] = {}
        self.rounds: dict[tuple[str, int], dict] = {}
        self._last_step = 0.0
        self.sample = load_sample()
        self.segments = [row["segment_id"] for row in self.sample.get("leaderboard", [])] or [
            "seg_keto_low_carb", "seg_protein_athlete"]
        self.arms = {a["arm_id"]: a for a in self.sample.get("by_arm", [])
                     if a.get("arm_id") != "arm_control" and a.get("angle")}

    # -- plumbing --
    async def _call(self, method: str, path: str, body: Any, fn) -> Any:
        keys = sorted(body.keys()) if isinstance(body, dict) else []
        await asyncio.sleep(0)
        try:
            out = fn()
            self.calls.append((method, path, keys, True))
            return out
        except ApiError:
            self.calls.append((method, path, keys, False))
            raise

    def _write_guard(self) -> None:
        if not self.runs_allowed:
            raise ApiError("runs_not_allowed", f"runs are not allowed on {self.db_name}", 403)

    def recipe(self, arm_id: str) -> str:
        a = self.arms.get(arm_id)
        if not a:
            return "Current ads (control)" if arm_id == "arm_control" else arm_id
        return f"{_label(a['angle'])} × {_label(a['hook'])}"

    # -- health and logging --
    async def health(self, timeout: float = 10.0) -> dict:
        def fn():
            has_run = bool(self.runs) or any(t["kind"] == "run_round" for t in self.board.values())
            return {"db_label": "FAKE", "db_name": self.db_name, "db_uri": "memory://fake",
                    "is_local": True, "mode": self.mode, "runs_allowed": self.runs_allowed,
                    "run_slot_free": not has_run,
                    "blocked_reason": "a run already exists; reset first" if has_run else None,
                    "runs": len(self.runs), "browser_db_name": self.db_name,
                    "browser_uri": "memory://fake", "browser_matches": True, "spacetime_ok": True,
                    "agent_tables": True}
        return await self._call("GET", "/health", None, fn)

    async def log_message(self, body: dict) -> dict:
        def fn():
            self._write_guard()
            problems = []
            if body.get("from_agent") not in PARTIES or body.get("to_agent") not in PARTIES:
                problems.append("unknown party")
            if body.get("from_agent") == body.get("to_agent"):
                problems.append("to_agent == from_agent")
            if body.get("kind") not in ("request", "reply", "progress", "result"):
                problems.append(f"bad kind {body.get('kind')!r}")
            if not body.get("protocol"):
                problems.append("missing protocol")
            summary = body.get("summary")
            if not isinstance(summary, str) or len(summary) > 140 or "\n" in summary:
                problems.append("summary is not one line of <= 140 characters")
            if not isinstance(body.get("payload"), dict):
                problems.append("payload is not an object")
            elif len(json.dumps(body["payload"]).encode()) > 4096:
                problems.append("payload over 4096 bytes")
            if body.get("run_id") is not None and not isinstance(body.get("run_id"), str):
                problems.append("bad run_id")
            if problems:
                raise ApiError("bad_request", "; ".join(problems), 400)
            message_id = f"msg_{int(time.time() * 1000):x}_{uuid.uuid4().hex[:8]}"
            self.log_messages.append({**body, "message_id": message_id, "created_at": iso()})
            return {"message_id": message_id}
        return await self._call("POST", "/log/message", body, fn)

    async def log_status(self, body: dict, timeout: float | None = None) -> dict:
        def fn():
            self._write_guard()
            ok = (body.get("agent_id") in AGENT_IDS and len(body.get("name", "")) <= 40
                  and len(body.get("role", "")) <= 80
                  and body.get("status") in ("idle", "working", "error")
                  and len(body.get("current_step", "")) <= 140
                  and (body.get("address", "") == "" or body["address"].startswith("agent1")))
            if not ok:
                raise ApiError("bad_request", f"bad status body {body}", 400)
            self.status_posts.append(dict(body))
            return {}
        return await self._call("POST", "/log/status", body, fn)

    # -- intel --
    PLANNED = [
        {"kind": "page", "target": "Catalina Crunch", "actor": "facebook-ads-library",
         "job_type": "adlib_sync_competitor", "ref_id": "brand_catalina", "last_synced_at": None},
        {"kind": "page", "target": "GHOST", "actor": "facebook-ads-library",
         "job_type": "adlib_sync_competitor", "ref_id": "brand_ghost",
         "last_synced_at": "2026-10-23T18:00:00Z"},
        {"kind": "page", "target": "Three Wishes", "actor": "facebook-ads-library",
         "job_type": "adlib_sync_competitor", "ref_id": "brand_three_wishes",
         "last_synced_at": "2026-10-24T02:00:00Z"},
        {"kind": "source", "target": "Reddit r/keto", "actor": "reddit-scraper",
         "job_type": "voc_reddit", "ref_id": "src_reddit_keto", "last_synced_at": None},
        {"kind": "source", "target": "Trustpilot", "actor": "trustpilot-scraper",
         "job_type": "voc_trustpilot", "ref_id": "src_trustpilot",
         "last_synced_at": "2026-10-22T10:00:00Z"},
    ]

    async def ingest_refresh(self, body: dict) -> dict:
        def fn():
            self.ingest_calls.append(dict(body))
            if body.get("requested_by") not in PARTIES:
                raise ApiError("bad_request", "requested_by must be an agent id or 'user'", 400)
            planned = sorted(self.PLANNED, key=lambda c: (c["last_synced_at"] is not None,
                                                          c["last_synced_at"] or ""))
            if body.get("dry"):
                return {"mode": self.mode, "planned": planned, "jobs": []}
            self._write_guard()
            targets = body.get("targets") or []
            by_ref = {c["ref_id"]: c for c in planned}
            if targets:
                pages = [t for t in targets if t.get("kind") == "page"]
                sources = [t for t in targets if t.get("kind") == "source"]
                if len(pages) > 4 or len(sources) > 3:
                    raise ApiError("bad_request", "at most 4 pages and 3 sources", 400)
                chosen = [by_ref[t["ref_id"]] for t in targets if t.get("ref_id") in by_ref]
            else:
                chosen = ([c for c in planned if c["kind"] == "page"][: body.get("pages", 2)]
                          + [c for c in planned if c["kind"] == "source"][: body.get("sources", 1)])
            jobs = [{"job_id": str(uuid.uuid4()), "target": c["target"], "actor": c["actor"],
                     "status": "skipped" if self.mode == "test" else "pending",
                     "dry": self.mode == "test", "deduped": False} for c in chosen]
            self.ingest_jobs.extend(jobs)
            return {"mode": self.mode, "planned": planned, "jobs": jobs}
        return await self._call("POST", "/ingest/refresh", body, fn)

    async def jobs(self, ids: list[str]) -> dict:
        def fn():
            rows = [j for j in self.ingest_jobs if j["job_id"] in set(ids)]
            return {"jobs": [{"job_id": j["job_id"], "job_type": "adlib_sync_competitor",
                              "status": j["status"], "error": None, "items": 0,
                              "target": j["target"], "actor": j["actor"], "attempts": 0}
                             for j in rows]}
        return await self._call("GET", "/jobs", None, fn)

    async def distill_start(self, body: dict) -> dict:
        def fn():
            self._write_guard()
            return {"started": False, "reason": "test mode: the brand corpus is current",
                    "facts": {"total": 96, "persona": 40, "market_prior": 24, "voc": 32}}
        return await self._call("POST", "/distill/start", body, fn)

    async def brand_kit(self) -> dict:
        def fn():
            if not self.brand_kit_ready:
                return {"ready": False, "reason": "no brand kit yet: set the brand URL and product "
                        "photo at /start", "brand_url": "", "brand_name": "", "image_file": "",
                        "image_path": "", "image_url": "", "updated_at": None}
            return {"ready": True, "reason": "", "brand_url": "https://magicspoon.com",
                    "brand_name": "Magic Spoon", "image_file": "0123456789ab.png",
                    "image_path": "/api/brand-kit/image/0123456789ab.png", "image_url": "",
                    "updated_at": "2026-10-25T09:00:00.000Z"}
        return await self._call("GET", "/brand-kit", None, fn)

    async def brand_summary(self, fresh: bool = False) -> dict:
        def fn():
            return {
                "brand": {"name": "Magic Spoon",
                          "positioning": "Fixture: high-protein, low-sugar cereal for adults who "
                                         "miss the taste of childhood cereal.",
                          "proof_points": ["13g protein (fixture)", "0g sugar (fixture)",
                                           "Keto friendly"]},
                "pains": [{"label": "price", "quote": "Fixture quote: love it but it's pricey.",
                           "frequency": 41, "platforms": ["reddit"]},
                          {"label": "taste_doubt", "quote": "", "frequency": 17,
                           "platforms": ["trustpilot"]}],
                "desires": [{"label": "guilt_free_snack", "quote": "", "frequency": 33,
                             "platforms": ["reddit"]}],
                "objections": [{"label": "not_needing_cereal", "quote": "", "frequency": 22,
                                "platforms": ["meta"]}],
                "personas": [{"segment_id": s, "name": seg_name(s), "share": round(1 / len(self.segments), 2)}
                             for s in self.segments],
            }
        return await self._call("GET", "/brand-summary", None, fn)

    async def competitor_summary(self) -> dict:
        def fn():
            return {
                "competitors": [{"name": "Catalina Crunch", "ads": 40, "winners": 9},
                                {"name": "GHOST", "ads": 50, "winners": 12},
                                {"name": "Three Wishes", "ads": 24, "winners": 5}],
                "winners": [
                    {"brand": "GHOST", "angle": "taste_indulgence", "hook": "bold_claim",
                     "headline": "Fixture: cereal milk you'll actually crave", "days_running": 94,
                     "image_url": "", "creative_id": "fx_ghost_1"},
                    {"brand": "Catalina Crunch", "angle": "dietary_fit", "hook": "problem_callout",
                     "headline": "Fixture: keto that crunches", "days_running": 41,
                     "image_url": "", "creative_id": "fx_cat_1"},
                    {"brand": "Three Wishes", "angle": "health_nutrition", "hook": "statistic",
                     "headline": "Fixture: 8g protein, 3g sugar", "days_running": 12,
                     "image_url": "", "creative_id": "fx_tw_1"},
                ],
                "patterns": [{"concept": "taste_indulgence", "share": 0.34},
                             {"concept": "dietary_fit", "share": 0.22}],
            }
        return await self._call("GET", "/competitor-summary", None, fn)

    async def contract_build(self, mode: str = "check") -> dict:
        def fn():
            if mode != "check":
                raise ApiError("not_supported", "rebuild is not supported tonight", 400)
            recipes = [{"arm_id": a["arm_id"], "strategy": a["strategy"], "angle": a["angle"],
                        "hook": a["hook"], "rationale": f"Fixture rationale for {a['arm_id']}."}
                       for a in self.arms.values()]
            recipes.append({"arm_id": "arm_control", "strategy": "control", "angle": "", "hook": "",
                            "rationale": "Magic Spoon's current ads."})
            return {"recipes": recipes,
                    "segments": [{"segment_id": s, "name": seg_name(s),
                                  "share": round(1 / len(self.segments), 2)} for s in self.segments],
                    "check": {"ok": True, "failures": [], "warnings": []},
                    "round0": {"complete": True, "expected": 54, "ranked": 54, "gated_out": 0,
                               "problems": []}}
        return await self._call("POST", "/contract/build", {"mode": mode}, fn)

    # -- the task board --
    def _task(self, task_id: str, kind: str, run_id: str, rnd: int, payload: dict) -> dict:
        now = iso()
        t = {"task_id": task_id, "run_id": run_id, "kind": kind, "status": "queued",
             "claimed_by": None, "payload": {**payload, "round": rnd}, "result": None,
             "created_at": now, "updated_at": now}
        self.board[task_id] = t
        return t

    def _set(self, t: dict, **fields) -> None:
        t.update(fields)
        t["updated_at"] = iso()

    def _gen_payload(self, run_id: str, rnd: int) -> dict:
        gen = self.sample.get("generation") or {}
        return {"run_id": run_id, "round": rnd, "arms": gen.get("arms") or [],
                "n_per_arm": gen.get("n_per_arm", 1), "learning_ids": gen.get("learning_ids") or []}

    def step(self, force: bool = False) -> bool:
        """One board transition (at most one per step_s unless forced)."""
        now = time.monotonic()
        if not force and now - self._last_step < self.step_s:
            return False
        for run_id, run in self.runs.items():
            if run["status"] == "done":
                continue
            R = run["rounds_planned"]
            rrs = [t for t in self.board.values() if t["run_id"] == run_id and t["kind"] == "run_round"]
            if not rrs:
                continue
            rr = max(rrs, key=lambda t: t["payload"]["round"])
            r = rr["payload"]["round"]
            row = self.rounds.get((run_id, r))
            if rr["status"] == "queued":
                self._set(rr, status="claimed", claimed_by="sim-worker:fake")
                if r > 0:
                    self.rounds[(run_id, r)] = {"round": r, "status": "running",
                                                "started_at": iso(), "finished_at": None}
            elif rr["status"] == "claimed" and row is None:
                self.rounds[(run_id, r)] = {"round": r, "status": "running", "started_at": iso(),
                                            "finished_at": None}
                run["status"] = "running"
            elif rr["status"] == "claimed" and row["status"] == "running":
                row.update(status="done", finished_at=iso())
                self._set(rr, status="done", result={"round": r, "impressions": 705})
                if r < R:
                    self._task(f"tsk_gen_{run_id}_r{r}", "generate_creatives", run_id, r,
                               self._gen_payload(run_id, r))
                else:
                    run["status"] = "done"
            else:
                continue
            self._last_step = now
            return True
        return False

    async def rounds_start(self, body: dict) -> dict:
        def fn():
            self._write_guard()
            run_id = str(body.get("run_id") or "")
            R = int(body.get("rounds_planned", 3))
            pop = int(body.get("population", 300))
            if not RUN_ID_RE.match(run_id) or not 1 <= R <= 5 or not 50 <= pop <= 300 \
                    or body.get("requested_by") not in PARTIES:
                raise ApiError("bad_request", "bad rounds/start body", 400)
            if run_id in self.runs:
                raise ApiError("run_exists", f"{run_id} already exists", 409)
            if self.runs:
                raise ApiError("db_has_run", f"{self.db_name} already holds a run", 409)
            self.runs[run_id] = {"run_id": run_id, "seed": int(body.get("seed", 13)),
                                 "population": pop, "rounds_planned": R, "ticks_per_round": 3,
                                 "status": "calibrating", "config_hash": "pending"}
            t = self._task(f"tsk_run_{run_id}_r0", "run_round", run_id, 0, {"run_id": run_id})
            self._last_step = time.monotonic()
            return {"run_id": run_id, "task_id": t["task_id"], "rounds_planned": R,
                    "population": pop, "seed": int(body.get("seed", 13))}
        return await self._call("POST", "/rounds/start", body, fn)

    def _status(self, run_id: str) -> dict:
        run = self.runs.get(run_id)
        tasks = sorted((t for t in self.board.values() if t["run_id"] == run_id),
                       key=lambda t: t["created_at"])
        rounds = [v for (rid, _), v in sorted(self.rounds.items()) if rid == run_id]
        phase = "done" if run and run["status"] == "done" else ("not_started" if not tasks else "round_running")
        return {"run": dict(run) if run else None, "rounds": [dict(r) for r in rounds],
                "tasks": [json.loads(json.dumps(t)) for t in tasks], "phase": phase,
                "current_round": rounds[-1]["round"] if rounds else None}

    async def rounds_status(self, run_id: str) -> dict:
        def fn():
            self.step()
            return self._status(run_id)
        return await self._call("GET", "/rounds/status", None, fn)

    async def rounds_summary(self, run_id: str, round_: int | None = None) -> dict:
        def fn():
            run = self.runs.get(run_id)
            if not run:
                raise ApiError("not_ready", f"{run_id} not found", 409)
            r = round_ if round_ is not None else max(
                (k[1] for k in self.rounds if k[0] == run_id), default=0)
            row = self.rounds.get((run_id, r))
            if not row or row["status"] != "done":
                raise ApiError("not_ready", f"round {r} is not done", 409)
            s = self.sample
            board = []
            for seg in s.get("leaderboard", []):
                def entry(e):
                    return {"arm_id": e["arm_id"], "recipe": self.recipe(e["arm_id"]),
                            "strategy": (self.arms.get(e["arm_id"]) or {}).get("strategy", "control"),
                            "p_best": e["p_best"], "cpo_usd": e["cpo_usd"],
                            "cpo_range_usd": e.get("cpo_range_usd"), "share": e["share_this_round"]}
                board.append({"segment_id": seg["segment_id"], "segment_name": seg_name(seg["segment_id"]),
                              "impressions": seg["impressions_this_round"],
                              "top": [entry(e) for e in seg["top"]],
                              "control": entry(seg["control"]) if seg.get("control") else None})
            opened = [self._learning(l) for l in (s.get("learnings") or {}).get("opened", [])[:4]]
            winners = []
            if r >= 1:
                winners = [{"segment_id": l["segment_id"], "segment_name": l["segment_name"],
                            "arm_id": l["arm_id"], "recipe": self.recipe(l["arm_id"] or ""),
                            "statement": l["statement"]}
                           for l in self._learnings() if l["kind"] == "winner"]
            jev = s.get("jev") or {}
            return {"round": r, "rounds_planned": run["rounds_planned"], "status": "done",
                    "totals": {"impressions": s.get("impressions", 0), "buys": s.get("buys", 0),
                               "taps": s.get("taps", 0), "jev_calls": jev.get("calls", 0),
                               "jev_cost_usd": jev.get("cost_usd", 0),
                               "cache_hit_rate": jev.get("cache_hit_rate", 0)},
                    "leaderboard": board, "learnings_opened": opened, "learnings_closed": [],
                    "winners": winners}
        return await self._call("GET", "/rounds/summary", None, fn)

    def _learning(self, l: dict) -> dict:
        lid = l["learning_id"]
        seg = next((s for s in self.segments if s.removeprefix("seg_") in lid), "")
        m = re.search(r"_winner_(\d+)_", lid)
        return {"learning_id": lid, "segment_id": seg, "segment_name": seg_name(seg) if seg else "",
                "arm_id": f"arm_{m.group(1)}" if m else None, "kind": l["kind"],
                "statement": l["statement"], "directive": l["directive"],
                "valid_from_round": 1, "valid_to_round": None}

    def _learnings(self) -> list[dict]:
        return [self._learning(l) for l in (self.sample.get("learnings") or {}).get("opened", [])]

    async def rounds_winners(self, run_id: str) -> dict:
        def fn():
            out = []
            winner_segs = {l["segment_id"]: l for l in self._learnings() if l["kind"] == "winner"}
            for seg in self.sample.get("leaderboard", []):
                sid = seg["segment_id"]
                top = seg["top"][0]
                win = winner_segs.get(sid)
                arm = win["arm_id"] if win else top["arm_id"]
                out.append({"segment_id": sid, "segment_name": seg_name(sid), "arm_id": arm,
                            "recipe": self.recipe(arm),
                            "statement": win["statement"] if win else "Leading, not yet significant.",
                            "basis": "winner" if win else "leading", "declared": bool(win),
                            "p_best": top["p_best"], "cpo_usd": top["cpo_usd"],
                            "control_cpo_usd": (seg.get("control") or {}).get("cpo_usd"),
                            "creative": {"creative_id": f"cr_fx_{run_id}_{sid}",
                                         "headline": f"Fixture headline for {seg_name(sid)}",
                                         "primary_text": "Fixture primary text.", "cta": "Shop now",
                                         "visual_description": "Fixture visual."}})
            return {"winners": out}
        return await self._call("GET", "/rounds/winners", None, fn)

    async def learnings(self, run_id: str, ids: list[str] | None = None) -> dict:
        def fn():
            rows = self._learnings()
            if ids:
                rows = [l for l in rows if l["learning_id"] in set(ids)]
            return {"learnings": rows}
        return await self._call("GET", "/learnings", None, fn)

    async def tasks(self, *, kind: str | None = None, status: str | None = None,
                    run_id: str | None = None, task_id: str | None = None) -> dict:
        def fn():
            self.step()
            rows = [t for t in self.board.values()
                    if (not kind or t["kind"] == kind) and (not status or t["status"] == status)
                    and (not run_id or t["run_id"] == run_id)
                    and (not task_id or t["task_id"] == task_id)]
            return {"tasks": [json.loads(json.dumps(t)) for t in sorted(rows, key=lambda t: t["created_at"])]}
        return await self._call("GET", "/tasks", None, fn)

    async def creatives_generate(self, task_id: str, learning_ids: list[str] | None = None,
                                 timeout: float = 330.0) -> dict:
        body = {"task_id": task_id, **({"learning_ids": learning_ids} if learning_ids else {})}
        self.generate_calls.append(body)
        keys = sorted(body)
        try:
            self._write_guard()
            t = self.board.get(task_id)
            if not t or t["kind"] != "generate_creatives":
                raise ApiError("task_not_found", task_id, 404)
            if t["status"] == "done":
                self.calls.append(("POST", "/creatives/generate", keys, True))
                return {**t["result"]}
            if self.claim_lost_on_generate or (t["status"] == "claimed"
                                               and t["claimed_by"] != "copywriter"):
                if t["status"] == "queued":
                    self._set(t, status="claimed", claimed_by="creative_worker")
                raise ApiError("claim_lost", f"{task_id} is claimed by {t['claimed_by']}", 409)
            self._set(t, status="claimed", claimed_by="copywriter")
            if self.fail_generate > 0:
                self.fail_generate -= 1
                raise ApiError("generate_failed", "fixture upstream error", 502)
            await asyncio.sleep(self.gen_delay_s)
            run_id, r = t["run_id"], t["payload"]["round"]
            nxt = f"tsk_run_{run_id}_r{r + 1}"
            self._task(nxt, "run_round", run_id, r + 1, {"run_id": run_id})
            applied = [x for x in t["payload"]["learning_ids"]
                       if not learning_ids or x in set(learning_ids)]
            ids = [f"cr_g{r + 1}_{run_id}_{a['arm_id']}_v1" for a in t["payload"]["arms"]]
            result = {"round_created": r + 1, "written": len(ids), "reused": 0, "ranked": len(ids),
                      "gated_out": 0, "creative_ids": ids, "skips": [], "errors": [],
                      "next_task": nxt}
            self._set(t, status="done", result=result)
            self.calls.append(("POST", "/creatives/generate", keys, True))
            return {**result, "learning_ids_applied": applied}
        except ApiError:
            self.calls.append(("POST", "/creatives/generate", keys, False))
            raise

    async def creatives_fail(self, task_id: str, error: str) -> dict:
        def fn():
            self._write_guard()
            self.fail_calls.append({"task_id": task_id, "error": error})
            t = self.board.get(task_id)
            if not t:
                raise ApiError("task_not_found", task_id, 404)
            self._set(t, status="failed", result={"error": error})
            return {"failed": True}
        return await self._call("POST", "/creatives/fail", {"task_id": task_id, "error": error}, fn)

    async def warm_generate(self) -> None:
        try:
            await self._call("POST", "/creatives/generate", {},
                             lambda: (_ for _ in ()).throw(ApiError("bad_request", "task_id required", 400)))
        except ApiError:
            pass
