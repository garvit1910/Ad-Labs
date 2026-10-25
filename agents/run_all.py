"""Entry point for the four Ad Lab agents.

  python agents/run_all.py                    one Bureau (port ADLAB_AGENTS_PORT, 8001), four mailbox agents
  python agents/run_all.py --solo scout       one agent on its own port (8002-8004) for inspector registration
  python agents/run_all.py --print-addresses  the four agent1q... addresses (no network calls)

Before building any Agent it waits for GET /health and chdirs into data/agents/<db_name>/, so
each agent's storage file is namespaced by the database the API points at (data/ is gitignored).
Never run this alongside `npm run agent` (hello_agent.py): both use AD_LAB_AGENT_SEED, which would
put two mailbox clients on one address.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common  # noqa: E402
from common import AGENT_SPECS, DATA_DIR, SEED_HINT, Config, Hub, Peers  # noqa: E402

INSPECT = "https://agentverse.ai/inspect/?uri=http%3A//127.0.0.1%3A{port}&address={addr}"


def print_addresses(cfg: Config) -> int:
    print(f"{'agent_id':<16} {'name':<18} address")
    missing = 0
    for key, spec in AGENT_SPECS.items():
        seed = cfg.seeds.get(key)
        if seed:
            addr = common.address_for_seed(seed)
        else:
            missing += 1
            addr = f"(not set: {spec.seed_env}; generate with {SEED_HINT})"
        print(f"{spec.agent_id:<16} {spec.name:<18} {addr}")
    return 0


def wait_for_health(api_url: str) -> dict:
    import httpx

    start = last_note = time.monotonic()
    while True:
        try:
            r = httpx.get(f"{api_url}/health", timeout=10.0)
            data = r.json()
            if data.get("ok"):
                return data["data"] or {}
        except Exception:
            pass
        if time.monotonic() - last_note >= 10 or last_note == start:
            print(f"waiting for the Ad Lab API at {api_url}; start it with `npm run dev:local` "
                  "(or dev:live)", flush=True)
            last_note = time.monotonic()
        time.sleep(3)


def build_all(hub: Hub, *, offline: bool, only: str | None = None) -> dict[str, Any]:
    import ad_lab
    import copywriter
    import scout
    import strategist

    builders = {"ad_lab": ad_lab.build, "scout": scout.build, "strategist": strategist.build,
                "copywriter": copywriter.build}
    agents = {}
    for key, build in builders.items():
        if only and key != only:
            continue
        agents[key] = build(hub, offline=offline, port=AGENT_SPECS[key].solo_port)
    return agents


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run Ad Lab's Fetch.ai agents")
    ap.add_argument("--solo", choices=list(AGENT_SPECS), help="run one agent on its own port")
    ap.add_argument("--print-addresses", action="store_true")
    ap.add_argument("--fake-api", action="store_true",
                    help="use the in-memory FakeApi instead of ADLAB_API_URL (offline debugging)")
    ap.add_argument("--offline", action="store_true",
                    help="no mailbox, no Almanac, derived seeds (local debugging only)")
    args = ap.parse_args(argv)

    cfg = common.load_config(derived=args.offline, offline=args.offline)
    if args.print_addresses:
        return print_addresses(cfg)

    keys = [args.solo] if args.solo else list(AGENT_SPECS)
    # Peers needs every address so messages log with the right agent ids.
    missing = common.missing_seeds(cfg, list(AGENT_SPECS) if not args.solo else keys)
    if missing:
        print(f"Missing seeds in .env.local: {', '.join(missing)}. Generate each with:\n  {SEED_HINT}",
              file=sys.stderr)
        return 2
    if args.solo:
        # The other agents' addresses only label log rows; derive stand-ins if their seeds are unset.
        for key in AGENT_SPECS:
            cfg.seeds[key] = cfg.seeds.get(key) or common.derive_seed(key, None)

    if args.fake_api:
        from fake_api import FakeApi

        api: Any = FakeApi(mode="test")
        db_name, health = "fake", {"db_label": "FAKE", "db_name": "fake", "mode": "test",
                                   "runs_allowed": True, "is_local": True}
    elif args.solo:
        api = common.Api(cfg.api_url)
        db_name, health = "_solo", {}
    else:
        health = wait_for_health(cfg.api_url)
        api = common.Api(cfg.api_url)
        db_name = str(health.get("db_name") or "unknown")

    state_dir = DATA_DIR / db_name
    state_dir.mkdir(parents=True, exist_ok=True)
    os.chdir(state_dir)  # KeyValueStore takes os.getcwd() when each Agent is built

    hub = Hub(cfg, api, Peers(cfg))
    agents = build_all(hub, offline=args.offline, only=args.solo)

    if health:
        print(f"-> {health.get('db_label', '')} {health.get('db_name')} "
              f"({'LOCAL' if health.get('is_local') else 'MAINCLOUD'}), mode={health.get('mode')}, "
              f"runs_allowed={health.get('runs_allowed')}, run_slot_free={health.get('run_slot_free')}")
    port = AGENT_SPECS[args.solo].solo_port if args.solo else cfg.port
    for key, agent in agents.items():
        spec = AGENT_SPECS[key]
        print(f"{spec.agent_id:<16} {spec.name:<18} {agent.address}")
        if not args.offline:
            print(f"  inspector: {INSPECT.format(port=port, addr=agent.address)}")
    print(f"state: {state_dir}", flush=True)

    if args.solo:
        agents[args.solo].run()
    else:
        from uagents import Bureau

        Bureau(agents=list(agents.values()), port=cfg.port).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
