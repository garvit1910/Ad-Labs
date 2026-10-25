"""Scout: decides which competitor pages and review sources are stale, refreshes them through
POST /ingest/refresh, and reports brand and competitor intel from the corpus already distilled.

Plan with dry:true (all candidates, stalest first), pick with a concrete staleness rule, then
execute with explicit targets [{kind, ref_id}] and requested_by 'agt_scout'. The server decides
test vs live: in test mode the execute call writes 'skipped' ingest_job rows and starts nothing.
When /health says !runs_allowed (or the database is B's), Scout stays dry and skips the execute.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import common
from common import AGENT_SPECS, ApiError, Hub, StatusReporter, clip, parse_ts, utcnow
from protocols import (
    INTEL_SPEC, P_INTEL, P_PROGRESS, BrandProfile, CompetitorAd, CompetitorIntel, CompetitorStat,
    IntelReport, IntelRequest, Pattern, Persona, Progress, RefreshJob, RefreshPick, VoiceItem)

SPEC = AGENT_SPECS["scout"]
PAGE_STALE_H = 6.0
SOURCE_STALE_H = 12.0
RECENT_H = 1.0
MAX_PAGES = 4  # contract caps execute targets at 4 pages and 3 sources
MAX_SOURCES = 3
JOB_POLL_S = 10.0
JOB_GIVE_UP_S = 20 * 60
TERMINAL = {"completed", "failed", "skipped", "cancelled"}


# --- pure helpers (unit-tested) -------------------------------------------------------------


def _ago(hours: float) -> str:
    return f"{hours:.0f} h ago" if hours < 48 else f"{hours / 24:.0f} days ago"


def pick_refresh_targets(planned: list[dict], now: datetime, max_pages: int = 2,
                         max_sources: int = 2, page_stale_h: float = PAGE_STALE_H,
                         source_stale_h: float = SOURCE_STALE_H) -> list[dict]:
    """Never-synced first, then oldest last_synced_at. A page qualifies when older than 6 h, a
    source when older than 12 h; nothing synced in the last hour qualifies. Classified on kind."""
    def age_h(c: dict) -> float | None:
        ts = parse_ts(c.get("last_synced_at"))
        return None if ts is None else max(0.0, (now - ts).total_seconds() / 3600)

    ordered = sorted(planned, key=lambda c: (age_h(c) is not None, -(age_h(c) or 0)))
    picks: list[dict] = []
    counts = {"page": 0, "source": 0}
    limits = {"page": min(max_pages, MAX_PAGES), "source": min(max_sources, MAX_SOURCES)}
    for c in ordered:
        kind = "page" if c.get("kind") == "page" else "source"
        if counts[kind] >= limits[kind]:
            continue
        h = age_h(c)
        stale = page_stale_h if kind == "page" else source_stale_h
        if h is not None and (h < max(RECENT_H, stale)):
            continue
        reason = "never synced" if h is None else f"last synced {_ago(h)}"
        picks.append({**c, "kind": kind, "reason": reason})
        counts[kind] += 1
    return picks


def brand_profile(data: dict | None) -> BrandProfile:
    d = data or {}
    b = d.get("brand") or {}

    def voice(rows: Any) -> list[VoiceItem]:
        return [VoiceItem(label=str(r.get("label") or ""), quote=str(r.get("quote") or ""),
                          frequency=int(r.get("frequency") or 0),
                          platforms=[str(p) for p in (r.get("platforms") or [])][:5])
                for r in (rows or [])[:8] if r.get("label")]

    return BrandProfile(
        name=str(b.get("name") or "Magic Spoon"), positioning=str(b.get("positioning") or ""),
        proof_points=[str(p) for p in (b.get("proof_points") or [])][:8],
        pains=voice(d.get("pains")), desires=voice(d.get("desires")),
        objections=voice(d.get("objections")),
        personas=[Persona(segment_id=str(p.get("segment_id", "")), name=str(p.get("name") or ""),
                          share=float(p.get("share") or 0)) for p in (d.get("personas") or [])])


def competitor_intel(data: dict | None) -> CompetitorIntel:
    d = data or {}
    return CompetitorIntel(
        competitors=[CompetitorStat(name=str(c.get("name") or ""), ads=int(c.get("ads") or 0),
                                    winners=int(c.get("winners") or 0))
                     for c in d.get("competitors") or []],
        winners=[CompetitorAd(brand=str(w.get("brand") or ""), angle=str(w.get("angle") or ""),
                              hook=str(w.get("hook") or ""), headline=str(w.get("headline") or ""),
                              days_running=int(w.get("days_running") or 0),
                              image_url=str(w.get("image_url") or ""),
                              creative_id=str(w.get("creative_id") or ""))
                 for w in (d.get("winners") or [])[:8]],
        patterns=[Pattern(concept=str(p.get("concept") or ""), share=float(p.get("share") or 0))
                  for p in (d.get("patterns") or [])[:6]])


def _names(picks: list[dict]) -> str:
    pages = [p["target"] for p in picks if p["kind"] == "page"]
    sources = [p["target"] for p in picks if p["kind"] == "source"]
    parts = []
    if pages:
        parts.append("Meta ads for " + ", ".join(pages))
    if sources:
        parts.append(", ".join(sources))
    return "; ".join(parts)


# --- the agent ------------------------------------------------------------------------------


class Scout:
    def __init__(self, hub: Hub, address: str):
        self.hub = hub
        self.api = hub.api
        self.status = StatusReporter(hub, SPEC, address)
        self._brand_cache: tuple[float, dict] | None = None
        self._comp_cache: tuple[float, dict] | None = None

    async def _progress(self, ctx, to: str, request_id: str, stage: str, text: str,
                        level: str = "info") -> None:
        msg = Progress(request_id=request_id, source="scout", stage=stage, text=text, level=level)
        await common.send_logged(self.hub, ctx, to, msg, protocol=P_PROGRESS, kind="progress",
                                 summary=text)

    async def tick(self, ctx) -> None:
        for item in common.inbox_take(ctx.storage):
            try:
                if item.get("t") == "IntelRequest":
                    await self.handle_intel(ctx, item)
                elif item.get("t") == "chat":
                    await common.answer_direct_chat(self.hub, ctx, SPEC, item, self.answer)
            except Exception as ex:
                ctx.logger.exception(f"scout item failed: {ex}")
        await self.watch_jobs(ctx)

    async def handle_intel(self, ctx, item: dict) -> None:
        req = IntelRequest.parse_obj(item["data"])
        to = item["sender"]
        await self.status.set("working", "choosing stale pages and sources")
        picks: list[dict] = []
        jobs: list[dict] = []
        mode, dry, notes, allowed = "test", True, [], False
        try:
            health = await self.api.health() or {}
            mode = str(health.get("mode") or "test")
            db = health.get("db_name") or "?"
            allowed = bool(health.get("runs_allowed")) and db not in common.DENY_RUN_DBS
            plan = await self.api.ingest_refresh({"requested_by": SPEC.agent_id, "dry": True})
            picks = pick_refresh_targets((plan or {}).get("planned") or [], utcnow(),
                                         req.max_pages, req.max_sources)
            if not picks:
                newest = [parse_ts(c.get("last_synced_at")) for c in (plan or {}).get("planned") or []]
                newest = [t for t in newest if t]
                ago = _ago((utcnow() - max(newest)).total_seconds() / 3600) if newest else "unknown"
                notes.append(f"Corpus is fresh (newest sync {ago}).")
                await self._progress(ctx, to, req.request_id, "refresh_skipped",
                                     f"Scout checked the sources: the corpus is fresh (newest sync "
                                     f"{ago}), so no refresh.")
            elif not (allowed and req.refresh):
                await self._progress(ctx, to, req.request_id, "refresh_planned",
                                     f"Scout picked {len(picks)} stale sources but stays dry "
                                     f"(writes are off on {db}): {_names(picks)}.")
            else:
                res = await self.api.ingest_refresh({
                    "requested_by": SPEC.agent_id,
                    "targets": [{"kind": p["kind"], "ref_id": p["ref_id"]} for p in picks]})
                mode = str((res or {}).get("mode") or mode)
                jobs = (res or {}).get("jobs") or []
                dry = mode != "live" or all(j.get("dry", True) for j in jobs)
                if dry:
                    await self._progress(ctx, to, req.request_id, "refresh_planned",
                                         f"Scout picked {len(picks)} stale sources to refresh "
                                         f"({mode} mode, so planned only and logged as skipped): "
                                         f"{_names(picks)}.")
                else:
                    await self._progress(ctx, to, req.request_id, "refresh_started",
                                         f"Scout started {len(jobs)} Apify runs: {_names(picks)}.")
        except ApiError as ex:
            notes.append(f"Refresh skipped: API error {ex.code}.")
            await self._progress(ctx, to, req.request_id, "api_error",
                                 f"Scout can't plan the refresh ({ex.code}: "
                                 f"{clip(ex.message, 80)}); reporting from the corpus on file.",
                                 "error")
        await self.status.set("working", "reading the distilled corpus")
        brand, comp = BrandProfile(), CompetitorIntel()
        try:
            brand = brand_profile(await self.api.brand_summary())
            comp = competitor_intel(await self.api.competitor_summary())
        except ApiError as ex:
            notes.append(f"Intel unavailable: {ex.code}.")
            await self._progress(ctx, to, req.request_id, "api_error",
                                 f"Scout can't read the brand or competitor summary ({ex.code}).",
                                 "error")
        notes.append("This run uses the corpus already distilled; a refresh feeds the next build.")
        report = IntelReport(
            request_id=req.request_id, mode=mode, dry=dry,
            picks=[RefreshPick(kind=p["kind"], target=str(p.get("target") or ""),
                               actor=str(p.get("actor") or ""), job_type=str(p.get("job_type") or ""),
                               ref_id=str(p.get("ref_id") or ""), last_synced_at=p.get("last_synced_at"),
                               reason=p.get("reason", "")) for p in picks],
            jobs=[RefreshJob(job_id=str(j.get("job_id") or ""), target=str(j.get("target") or ""),
                             actor=str(j.get("actor") or ""), status=str(j.get("status") or ""),
                             dry=bool(j.get("dry", True))) for j in jobs],
            brand=brand, competitors=comp, note=" ".join(notes))
        summary = (f"Intel: {len(brand.pains)} pains, {len(comp.winners)} competitor winners; "
                   f"refresh {len(picks)} picked, {len(jobs)} jobs ({mode})")
        await common.send_logged(self.hub, ctx, to, report, protocol=P_INTEL, kind="reply",
                                 summary=summary)
        if jobs:
            watch = ctx.storage.get("scout:watch") or {}
            watch[req.request_id] = {"to": to, "jobs": {str(j.get("job_id")): str(j.get("status"))
                                                        for j in jobs if j.get("job_id")},
                                     "targets": {str(j.get("job_id")): str(j.get("target") or "")
                                                 for j in jobs},
                                     "started": utcnow().timestamp(), "last_poll": 0.0,
                                     "allowed": allowed, "dry": dry}
            ctx.storage.set("scout:watch", watch)
        await self.status.set("idle", "waiting for requests")

    async def watch_jobs(self, ctx) -> None:
        watch = ctx.storage.get("scout:watch") or {}
        if not watch:
            return
        now = utcnow().timestamp()
        changed = False
        for request_id, w in list(watch.items()):
            pending = [j for j, s in w["jobs"].items() if s not in TERMINAL]
            if pending and now - w["last_poll"] < JOB_POLL_S:
                continue
            w["last_poll"] = now
            changed = True
            if pending:
                try:
                    rows = ((await self.api.jobs(pending)) or {}).get("jobs") or []
                except ApiError:
                    rows = []
                for row in rows:
                    jid, status = str(row.get("job_id")), str(row.get("status"))
                    if jid in w["jobs"] and status != w["jobs"][jid] and status in TERMINAL:
                        items = row.get("items")
                        extra = f" (+{items} items)" if items else ""
                        await self._progress(ctx, w["to"], request_id, "job_done",
                                             f"Apify: {w['targets'].get(jid) or jid} {status}{extra}")
                    if jid in w["jobs"]:
                        w["jobs"][jid] = status
                pending = [j for j, s in w["jobs"].items() if s not in TERMINAL]
            if pending and now - w["started"] < JOB_GIVE_UP_S:
                continue
            if pending:
                await self._progress(ctx, w["to"], request_id, "refresh_slow",
                                     "Refresh still running in the background; /agents shows the "
                                     "jobs (is the job worker running?).", "warn")
            else:
                statuses = list(w["jobs"].values())
                done = sum(1 for s in statuses if s == "completed")
                failed = sum(1 for s in statuses if s == "failed")
                skipped = sum(1 for s in statuses if s in ("skipped", "cancelled"))
                if not w.get("dry"):  # a dry refresh already said "planned only"
                    await self._progress(ctx, w["to"], request_id, "refresh_done",
                                         f"Refresh finished: {done} completed, {failed} failed, "
                                         f"{skipped} skipped.")
                if w.get("allowed"):
                    await self._distill(ctx, w["to"], request_id)
            del watch[request_id]
        if changed:
            ctx.storage.set("scout:watch", watch)

    async def _distill(self, ctx, to: str, request_id: str) -> None:
        try:
            d = await self.api.distill_start({"requested_by": SPEC.agent_id}) or {}
        except ApiError as ex:
            await self._progress(ctx, to, request_id, "distill", f"No re-distill: {ex.code}.")
            return
        facts = (d.get("facts") or {}).get("total")
        tail = f" ({facts} brand facts on file)" if facts is not None else ""
        text = (f"Scout started a brand re-distill{tail}." if d.get("started")
                else f"No re-distill: {clip(d.get('reason') or 'not needed', 90)}{tail}.")
        await self._progress(ctx, to, request_id, "distill", text)

    # -- direct chat (cached for 10 min) --
    async def answer(self, ctx, text: str) -> str:
        now = utcnow().timestamp()
        low = text.lower()
        if "competitor" in low or "winning" in low:
            if not self._comp_cache or now - self._comp_cache[0] > 600:
                self._comp_cache = (now, await self.api.competitor_summary() or {})
            comp = competitor_intel(self._comp_cache[1])
            lines = ["Top competitor ads still running:"]
            lines += [f"{i + 1}. {w.brand}: '{clip(w.headline, 80)}' ({w.angle} × {w.hook}, "
                      f"{w.days_running} days)" for i, w in enumerate(comp.winners[:5])]
            return "\n".join(lines)
        if not self._brand_cache or now - self._brand_cache[0] > 600:
            self._brand_cache = (now, await self.api.brand_summary() or {})
        b = brand_profile(self._brand_cache[1])

        def top(label: str, rows: list[VoiceItem]) -> str:
            if not rows:
                return f"{label}: none on file"
            quote = f' ("{clip(rows[0].quote, 120)}")' if rows[0].quote else ""
            return f"{label}: " + ", ".join(r.label for r in rows[:3]) + quote

        return "\n".join([f"What {b.name}'s customers say:", top("Pains", b.pains),
                          top("Desires", b.desires), top("Objections", b.objections),
                          "Ask me about competitors for their longest-running ads."])


def build(hub: Hub, *, offline: bool, port: int | None = None) -> Any:
    from uagents import Protocol

    agent = common.make_agent(SPEC, hub.cfg.seeds["scout"], port=port or SPEC.solo_port,
                              offline=offline)
    s = Scout(hub, agent.address)
    common.add_chat_inbox(agent, offline)
    intel = Protocol(spec=INTEL_SPEC, role="scout")
    intel.on_message(IntelRequest)(common.typed_to_inbox(IntelRequest))
    agent.include(intel, publish_manifest=not offline)

    @agent.on_event("startup")
    async def _startup(ctx):
        await s.status.set("idle", "online")

    @agent.on_interval(hub.cfg.scout_s)
    async def _work(ctx):
        await s.tick(ctx)

    @agent.on_interval(60)
    async def _heartbeat(ctx):
        await s.status.heartbeat()

    agent._adlab = s
    return agent
