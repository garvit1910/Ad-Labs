"""Shared plumbing for the four Ad Lab agents.

- config and seeds (`load_config`), agent specs and the address book (`Peers`);
- the HTTP client for app/api/agent (`Api`, httpx.AsyncClient only). httpx 0.28.1 is already
  pinned in agents/uv.lock through uagents-core, so pyproject and the lock stay unchanged
  (`uv add httpx==0.28.1` can come later, when online);
- `send_logged` / `send_chat`: every inter-agent and user-facing message is logged to
  POST /log/message first, then sent. Logging failures never break the flow;
- `StatusReporter` keeps the agent row current through POST /log/status;
- per-message inboxes: message handlers only write `inbox:<seq>` keys and each agent's single
  worker interval consumes them, so no two tasks read-modify-write the same storage key.

Nothing here builds an Agent at import time; only `make_agent` (called by the build()
factories) does.
"""

from __future__ import annotations

import asyncio
import hashlib
import itertools
import json
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterator

import httpx

AGENTS_DIR = Path(__file__).resolve().parent
REPO = AGENTS_DIR.parent
DATA_DIR = REPO / "data" / "agents"

DEFAULT_API_URL = "http://localhost:3000/api/agent"
DENY_RUN_DBS = {"adlab-calhacks13"}  # B's demo database; the server's runs_allowed says so too
LOG_TIMEOUT_S = 5.0
WARM_TIMEOUT_S = 30.0
SEED_HINT = 'python3 -c "import secrets;print(secrets.token_hex(32))"'


# --- agent specs ----------------------------------------------------------------------------


@dataclass(frozen=True)
class AgentSpec:
    key: str
    agent_id: str
    name: str
    role: str
    seed_env: str
    solo_port: int

    @property
    def profile_path(self) -> Path:
        return AGENTS_DIR / "profiles" / f"{self.agent_id}.md"


AGENT_SPECS: dict[str, AgentSpec] = {
    "ad_lab": AgentSpec(
        "ad_lab", "agt_ad_lab", "Ad Lab",
        "Orchestrator: the ASI:One chat, delegation and cards", "AD_LAB_AGENT_SEED", 8001,
    ),
    "scout": AgentSpec(
        "scout", "agt_scout", "Ad Lab Scout",
        "Intel: Apify refreshes, distillation, brand and competitor summaries",
        "SCOUT_AGENT_SEED", 8002,
    ),
    "strategist": AgentSpec(
        "strategist", "agt_strategist", "Ad Lab Strategist",
        "Recipes, rounds on the task board, results and winners", "STRATEGIST_AGENT_SEED", 8003,
    ),
    "copywriter": AgentSpec(
        "copywriter", "agt_copywriter", "Ad Lab Copywriter",
        "Writes each round's new ads from the learnings", "COPYWRITER_AGENT_SEED", 8004,
    ),
}
AGENT_IDS = {spec.agent_id for spec in AGENT_SPECS.values()}


# --- config ---------------------------------------------------------------------------------


@dataclass
class Config:
    api_url: str = DEFAULT_API_URL
    port: int = 8001
    rounds_planned: int = 3
    payment: bool = False  # ADLAB_PAYMENT: the Payment Protocol is cut; the flag stays off
    seeds: dict[str, str | None] = field(default_factory=dict)
    offline: bool = False
    worker_s: float = 0.5  # Ad Lab's inbox worker
    scout_s: float = 1.0
    strategist_s: float = 2.0
    watch_s: float = 5.0  # Strategist's task-board watch
    poll_s: float = 3.0  # Copywriter's queued-task poll
    retry_delays: tuple[float, ...] = (20.0, 40.0, 80.0)  # Copywriter, on generate_failed


def load_env() -> None:
    """Secrets live only in the repo-root .env.local (never overrides the process env)."""
    try:
        from dotenv import load_dotenv

        load_dotenv(REPO / ".env.local")
    except Exception:  # pragma: no cover - dotenv is a direct dependency
        pass


def derive_seed(key: str, real: str | None) -> str:
    """Offline seed for e2e and tests: never equal to the real seed, so the derived agents get
    their own addresses and never touch the registered agents' Almanac status."""
    return hashlib.sha256(f"adlab-offline|{key}|{real or ''}".encode()).hexdigest()


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "") or default)
    except ValueError:
        return default


def load_config(*, derived: bool = False, offline: bool = False) -> Config:
    load_env()
    seeds: dict[str, str | None] = {}
    for key, spec in AGENT_SPECS.items():
        real = (os.getenv(spec.seed_env) or "").strip() or None
        seeds[key] = derive_seed(key, real) if derived else real
    return Config(
        api_url=(os.getenv("ADLAB_API_URL") or DEFAULT_API_URL).rstrip("/"),
        port=_int_env("ADLAB_AGENTS_PORT", 8001),
        rounds_planned=max(1, min(5, _int_env("STRATEGIST_ROUNDS_PLANNED", 3))),
        payment=os.getenv("ADLAB_PAYMENT", "0") == "1",
        seeds=seeds,
        offline=offline,
    )


def missing_seeds(cfg: Config, keys: list[str] | None = None) -> list[str]:
    keys = keys or list(AGENT_SPECS)
    return [AGENT_SPECS[k].seed_env for k in keys if not cfg.seeds.get(k)]


def address_for_seed(seed: str) -> str:
    from uagents_core.identity import Identity

    return Identity.from_seed(seed, 0).address


class Peers:
    """agent_id <-> address, all computed from the seeds. Unknown addresses are 'user'."""

    def __init__(self, cfg: Config):
        self._by_id: dict[str, str] = {}
        self._by_address: dict[str, str] = {}
        for key, spec in AGENT_SPECS.items():
            seed = cfg.seeds.get(key)
            if seed:
                addr = address_for_seed(seed)
                self._by_id[spec.agent_id] = addr
                self._by_address[addr] = spec.agent_id

    def address(self, agent_id: str) -> str:
        return self._by_id[agent_id]

    def id_for(self, address: str) -> str:
        return self._by_address.get(address, "user")


# --- size limits ----------------------------------------------------------------------------

_WS = re.compile(r"\s+")


def clip(text: Any, n: int = 140) -> str:
    """One line of at most n characters (code points), ending in '…' when cut."""
    s = _WS.sub(" ", str(text if text is not None else "")).strip()
    if len(s) <= n:
        return s
    return s[: max(0, n - 1)].rstrip() + "…"


def _jbytes(x: Any) -> int:
    return len(json.dumps(x, default=str).encode())


def cap_payload(payload: Any, limit: int = 4096) -> dict:
    """Shrink until len(json.dumps(x).encode()) <= limit (json.dumps escapes non-ASCII, so the
    preview is cut in a loop rather than once)."""
    if not isinstance(payload, dict):
        payload = {"value": payload}
    try:
        safe = json.loads(json.dumps(payload, default=str))
    except Exception:
        safe = {"value": str(payload)}
    total = _jbytes(safe)
    if total <= limit:
        return safe
    text = json.dumps(safe, default=str, ensure_ascii=False)
    keys = [clip(k, 40) for k in list(safe.keys())[:30]]
    n = min(len(text), limit)
    while n > 0:
        out = {"_truncated": True, "_bytes": total, "keys": keys, "preview": text[:n]}
        if _jbytes(out) <= limit:
            return out
        n = int(n * 0.8)
    out = {"_truncated": True, "_bytes": total, "keys": keys}
    while keys and _jbytes(out) > limit:
        keys.pop()
    return out if _jbytes(out) <= limit else {"_truncated": True, "_bytes": total}


# --- time -----------------------------------------------------------------------------------


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def parse_ts(value: Any) -> datetime | None:
    """ISO string (with Z or offset) or an epoch number in s, ms or µs."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        if v > 1e14:
            v /= 1e6
        elif v > 1e11:
            v /= 1e3
        return datetime.fromtimestamp(v, tz=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def iso(dt: datetime | None = None) -> str:
    return (dt or utcnow()).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# --- HTTP API -------------------------------------------------------------------------------


class ApiError(Exception):
    """code: the contract code (bad_request, db_has_run, claim_lost, generate_failed, ...) or a
    transport code (api_down, timeout, no_route, http_<status>)."""

    def __init__(self, code: str, message: str = "", status: int | None = None):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message
        self.status = status


class Api:
    """Client for app/api/agent (frozen contract v1). Unwraps {ok:true, data}; {ok:false, error,
    code} becomes ApiError(code). One httpx.AsyncClient per running event loop."""

    def __init__(self, base_url: str = DEFAULT_API_URL, *, log_timeout: float = LOG_TIMEOUT_S):
        self.base_url = base_url.rstrip("/")
        self.log_timeout = log_timeout
        self.calls: list[tuple[str, str, list[str], bool]] = []
        self._client: httpx.AsyncClient | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _http(self) -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        if self._client is None or self._loop is not loop:
            self._client = httpx.AsyncClient()
            self._loop = loop
        return self._client

    async def request(self, method: str, path: str, *, params: dict | None = None,
                      body: Any = None, timeout: float = 30.0) -> Any:
        params = {k: v for k, v in (params or {}).items() if v is not None and v != ""}
        keys = sorted(body.keys()) if isinstance(body, dict) else []
        ok = False
        try:
            try:
                resp = await self._http().request(
                    method, f"{self.base_url}{path}", params=params or None,
                    json=body if method != "GET" else None, timeout=timeout,
                )
            except (httpx.ConnectError, httpx.ConnectTimeout) as ex:
                raise ApiError("api_down", f"{self.base_url}: {ex.__class__.__name__}") from None
            except httpx.TimeoutException:
                raise ApiError("timeout", f"{method} {path} after {timeout:.0f}s") from None
            except httpx.HTTPError as ex:
                raise ApiError("api_down", f"{ex.__class__.__name__}: {ex}") from None
            try:
                data = resp.json()
            except ValueError:
                code = "no_route" if resp.status_code == 404 else f"http_{resp.status_code}"
                raise ApiError(code, resp.text[:200], resp.status_code) from None
            if isinstance(data, dict) and data.get("ok") is True:
                ok = True
                return data.get("data")
            if isinstance(data, dict) and data.get("ok") is False:
                raise ApiError(str(data.get("code") or f"http_{resp.status_code}"),
                               str(data.get("error") or ""), resp.status_code)
            raise ApiError(f"http_{resp.status_code}", "response is not the {ok, data} envelope",
                           resp.status_code)
        finally:
            self.calls.append((method, path, keys, ok))
            if len(self.calls) > 10000:
                del self.calls[:5000]

    # -- thin wrappers (contract v1) --
    async def health(self, timeout: float = 10.0) -> dict:
        return await self.request("GET", "/health", timeout=timeout)

    async def log_message(self, body: dict) -> dict:
        return await self.request("POST", "/log/message", body=body, timeout=self.log_timeout)

    async def log_status(self, body: dict, timeout: float | None = None) -> dict:
        return await self.request("POST", "/log/status", body=body,
                                  timeout=timeout or self.log_timeout)

    async def ingest_refresh(self, body: dict) -> dict:
        return await self.request("POST", "/ingest/refresh", body=body, timeout=60.0)

    async def jobs(self, ids: list[str]) -> dict:
        return await self.request("GET", "/jobs", params={"ids": ",".join(ids[:20])})

    async def distill_start(self, body: dict) -> dict:
        return await self.request("POST", "/distill/start", body=body)

    async def brand_summary(self, fresh: bool = False) -> dict:
        return await self.request("GET", "/brand-summary", params={"fresh": "1" if fresh else None},
                                  timeout=60.0)

    async def competitor_summary(self) -> dict:
        return await self.request("GET", "/competitor-summary", timeout=60.0)

    async def contract_build(self, mode: str = "check") -> dict:
        return await self.request("POST", "/contract/build", body={"mode": mode}, timeout=180.0)

    async def rounds_start(self, body: dict) -> dict:
        return await self.request("POST", "/rounds/start", body=body, timeout=60.0)

    async def rounds_status(self, run_id: str) -> dict:
        return await self.request("GET", "/rounds/status", params={"run_id": run_id})

    async def rounds_summary(self, run_id: str, round_: int | None = None) -> dict:
        return await self.request("GET", "/rounds/summary",
                                  params={"run_id": run_id, "round": round_})

    async def rounds_winners(self, run_id: str) -> dict:
        return await self.request("GET", "/rounds/winners", params={"run_id": run_id})

    async def learnings(self, run_id: str, ids: list[str] | None = None) -> dict:
        return await self.request("GET", "/learnings",
                                  params={"run_id": run_id, "ids": ",".join(ids or []) or None})

    async def tasks(self, *, kind: str | None = None, status: str | None = None,
                    run_id: str | None = None, task_id: str | None = None) -> dict:
        return await self.request("GET", "/tasks", params={
            "kind": kind, "status": status, "run_id": run_id, "task_id": task_id})

    async def creatives_generate(self, task_id: str, learning_ids: list[str] | None = None,
                                 timeout: float = 330.0) -> dict:
        body: dict[str, Any] = {"task_id": task_id}
        if learning_ids:
            body["learning_ids"] = learning_ids[:50]
        return await self.request("POST", "/creatives/generate", body=body, timeout=timeout)

    async def creatives_fail(self, task_id: str, error: str) -> dict:
        return await self.request("POST", "/creatives/fail",
                                  body={"task_id": task_id, "error": clip(error, 500)})

    async def warm_generate(self) -> None:
        """POST /creatives/generate {} is a fast 400; it compiles the route on a cold next dev."""
        try:
            await self.request("POST", "/creatives/generate", body={}, timeout=WARM_TIMEOUT_S)
        except ApiError:
            pass


# --- hub: what every agent in the process shares --------------------------------------------


class Hub:
    def __init__(self, cfg: Config, api: Any, peers: Peers):
        self.cfg = cfg
        self.api = api
        self.peers = peers
        self.log_records: list[dict] = []  # one per /log/message attempt: {ok, message_id|error, body}
        self.sends: list[tuple[str, str, str]] = []  # (from, to, protocol) per message actually sent

    async def log(self, body: dict, logger: Any = None) -> None:
        try:
            res = await self.api.log_message(body)
            self.log_records.append({"ok": True, "message_id": (res or {}).get("message_id"),
                                     "body": body})
        except Exception as ex:  # logging never breaks the flow
            self.log_records.append({"ok": False, "error": str(ex), "body": body})
            if logger is not None:
                logger.warning(f"log/message failed: {ex}")
        for records in (self.log_records, self.sends):  # bounded in a long-running process
            if len(records) > 5000:
                del records[:1000]


def model_payload(msg: Any) -> dict:
    try:
        return json.loads(msg.json())
    except Exception:
        return {"value": str(msg)}


def log_body(frm: str, to: str, protocol: str, kind: str, summary: str, payload: Any,
             run_id: str = "") -> dict:
    body = {"from_agent": frm, "to_agent": to, "protocol": protocol, "kind": kind,
            "summary": clip(summary) or protocol, "payload": cap_payload(payload)}
    if run_id:
        body["run_id"] = run_id
    return body


async def send_logged(hub: Hub, ctx: Any, to_address: str, msg: Any, *, protocol: str, kind: str,
                      summary: str, run_id: str = "", payload: dict | None = None) -> None:
    """Log first (so agent_message stays in causal order with local dispatch), then send."""
    frm = hub.peers.id_for(ctx.agent.address)
    to = hub.peers.id_for(to_address)
    body = log_body(frm, to, protocol, kind, summary,
                    payload if payload is not None else model_payload(msg), run_id)
    await hub.log(body, ctx.logger)
    try:
        await ctx.send(to_address, msg)
        hub.sends.append((frm, to, protocol))
    except Exception as ex:
        ctx.logger.error(f"send to {to} failed: {ex}")


@lru_cache(maxsize=1)
def chat_digest() -> str:
    from uagents_core.contrib.protocols.chat import chat_protocol_spec

    return chat_protocol_spec.digest


def _as_uuid(session: Any) -> uuid.UUID | None:
    if session is None or session == "":
        return None
    if isinstance(session, uuid.UUID):
        return session
    try:
        return uuid.UUID(str(session))
    except ValueError:
        return None


async def send_on_session(ctx: Any, destination: str, msg: Any, session: Any,
                          protocol_digest: str | None) -> Any:
    """send_raw on an InternalContext built for `session`, carrying `protocol_digest`.
    Used for chat messages triggered by intervals or other agents: ctx.send from a typed-protocol
    handler would carry that protocol's digest, and an interval ctx has a fresh session."""
    from uagents.context import InternalContext
    from uagents_core.models import Model

    ictx = InternalContext(
        agent=ctx.agent, storage=ctx.storage, ledger=ctx.ledger,
        resolver=ctx._resolver, dispenser=ctx._dispenser, session=_as_uuid(session),
        interval_messages=None, message_history=getattr(ctx, "_message_history", None),
        logger=ctx.logger,
    )
    return await ictx.send_raw(destination, Model.build_schema_digest(msg),
                               msg.model_dump_json(), protocol_digest=protocol_digest)


async def send_chat(hub: Hub, ctx: Any, to_address: str, text: str, *, card: Any = None,
                    end_session: bool = False, session: Any = None, kind: str = "reply",
                    run_id: str = "", summary: str | None = None) -> bool:
    """One ChatMessage to a user: text (the plain-text narration), an optional Interactive Card
    (dropped, text kept, if it fails validation or exceeds 60 KB) and an optional
    EndSessionContent. Logged as <me> -> user on AgentChatProtocol, then sent on `session` with
    the chat protocol digest. Returns True when the card went out."""
    import cards as cards_mod
    from uagents_core.contrib.protocols.chat import ChatMessage, EndSessionContent, TextContent

    content: list[Any] = [TextContent(text=text)]
    card_block = cards_mod.to_content(card) if card is not None else None
    if card_block is not None:
        content.append(card_block)
    if end_session:
        content.append(EndSessionContent())
    msg = ChatMessage(content=content)
    frm = hub.peers.id_for(ctx.agent.address)
    payload = {"text": text[:1500], "end_session": end_session}
    if card_block is not None:
        payload.update(card_kind=card.kind, card_title=card.title, is_terminal=card.is_terminal)
    body = log_body(frm, "user", "AgentChatProtocol", kind, summary or text, payload, run_id)
    await hub.log(body, ctx.logger)
    try:
        await send_on_session(ctx, to_address, msg, session, chat_digest())
        hub.sends.append((frm, "user", "AgentChatProtocol"))
    except Exception as ex:
        ctx.logger.error(f"chat send failed: {ex}")
    return card_block is not None


# --- status ---------------------------------------------------------------------------------


class StatusReporter:
    """POST /log/status on every step change (skipped when unchanged). The first post uses a
    30 s timeout, which also warms the route on a cold next dev."""

    def __init__(self, hub: Hub, spec: AgentSpec, address: str):
        self.hub = hub
        self.spec = spec
        self.address = address
        self.last: tuple[str, str] | None = None
        self._warm = True

    async def set(self, status: str, step: str) -> None:
        key = (status, clip(step))
        if key == self.last:
            return
        self.last = key
        await self._post(*key)

    async def heartbeat(self) -> None:
        if self.last:
            await self._post(*self.last)

    async def _post(self, status: str, step: str) -> None:
        body = {"agent_id": self.spec.agent_id, "name": self.spec.name[:40],
                "role": self.spec.role[:80], "address": self.address, "status": status,
                "current_step": step}
        try:
            await self.hub.api.log_status(body, timeout=WARM_TIMEOUT_S if self._warm else None)
            self._warm = False
        except Exception:
            pass


# --- inboxes --------------------------------------------------------------------------------

_SEQ = itertools.count()
INBOX = "inbox:"


def inbox_put(storage: Any, item: dict) -> str:
    """Handlers only ever write a fresh per-message key."""
    key = f"{INBOX}{time.time_ns():020d}:{next(_SEQ):06d}"
    storage.set(key, item)
    return key


def inbox_take(storage: Any) -> Iterator[dict]:
    """The worker interval drains the inbox oldest first. Each key is removed only after its item
    was handled (when the loop asks for the next one), so a restart mid-item redelivers it.
    Every caller catches errors per item, so a failing item is still removed."""
    data = getattr(storage, "_data", {})
    for key in sorted(k for k in list(data.keys()) if k.startswith(INBOX)):
        item = storage.get(key)
        if isinstance(item, dict):
            yield item
        storage.remove(key)


def typed_to_inbox(model: type) -> Callable[..., Awaitable[None]]:
    async def _handler(ctx: Any, sender: str, msg: Any) -> None:
        inbox_put(ctx.storage, {"t": model.__name__, "sender": sender, "data": model_payload(msg)})

    _handler.__name__ = f"inbox_{model.__name__}"
    return _handler


# --- agents ---------------------------------------------------------------------------------


def make_agent(spec: AgentSpec, seed: str, *, port: int, offline: bool) -> Any:
    """Online: mailbox agent with its Agentverse profile. Offline (e2e, tests): no mailbox, no
    inspector, no published details, and the Almanac status call stubbed out, so nothing leaves
    the machine."""
    from uagents import Agent

    agent = Agent(
        name=spec.name, seed=seed, port=port, mailbox=not offline,
        publish_agent_details=not offline, description=spec.role,
        readme_path=str(spec.profile_path) if spec.profile_path.exists() else None,
        enable_agent_inspector=not offline, mark_inactive_on_shutdown=not offline,
    )
    if offline:
        async def _no_almanac_status(active: bool) -> None:
            return None

        agent._update_agent_status = _no_almanac_status
    return agent


def add_chat_inbox(agent: Any, offline: bool) -> None:
    """The chat protocol: acknowledge at once, then hand the message to the worker interval
    (with the inbound session, which the reply goes out on)."""
    from uagents import Protocol
    from uagents_core.contrib.protocols.chat import (
        ChatAcknowledgement, ChatMessage, chat_protocol_spec)

    proto = Protocol(spec=chat_protocol_spec)

    @proto.on_message(ChatMessage)
    async def _on_chat(ctx: Any, sender: str, msg: ChatMessage) -> None:
        await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))
        inbox_put(ctx.storage, {"t": "chat", "sender": sender, "session": str(ctx.session),
                                "msg_id": str(msg.msg_id), "msg": msg.json()})

    @proto.on_message(ChatAcknowledgement)
    async def _on_ack(ctx: Any, sender: str, msg: ChatAcknowledgement) -> None:
        ctx.logger.debug(f"{sender} acknowledged {msg.acknowledged_msg_id}")

    agent.include(proto, publish_manifest=not offline)


def parse_chat(item: dict) -> Any:
    from uagents_core.contrib.protocols.chat import ChatMessage

    return ChatMessage.parse_raw(item["msg"])


async def answer_direct_chat(hub: Hub, ctx: Any, spec: AgentSpec, item: dict,
                             answer: Callable[[Any, str], Awaitable[str]]) -> None:
    """Scout, Strategist and Copywriter answer direct ASI:One chats (one reply, then end)."""
    msg = parse_chat(item)
    text = msg.text().strip()
    if not text:
        return
    await hub.log(log_body("user", spec.agent_id, "AgentChatProtocol", "request", text,
                           {"text": text[:1500]}), ctx.logger)
    try:
        reply = await answer(ctx, text)
    except Exception as ex:
        reply = f"{spec.name} hit a problem: {clip(ex, 200)}"
    await send_chat(hub, ctx, item["sender"], reply, end_session=True, session=item.get("session"),
                    kind="reply")
