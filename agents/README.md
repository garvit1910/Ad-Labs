# Ad Lab agents (Fetch.ai uAgents)

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

Four uAgents run Ad Lab's loop by messaging each other. You talk to **Ad Lab** in ASI:One; it delegates to the other three, and every hop is a typed message logged to `agent_message`, so `/agents` shows the conversation live.

Python 3.12 managed by uv, with `uagents==0.25.5` (AgentChatProtocol 0.3.0, Interactive Cards from `uagents_core` 0.4.12). The agents never touch SpacetimeDB, Supabase or Apify directly: every action goes through the Next API at `ADLAB_API_URL` (default `http://localhost:3000/api/agent`), which decides which database is in use.

| Agent | Address | Job |
| --- | --- | --- |
| Ad Lab | `agent1qdefjvvn2z2lhxx394lvgw6upyk979a7znajm8xwuy2kqlssc932q5r7q3m` | The ASI:One chat: delegates, posts the five cards, answers "status" |
| Ad Lab Scout | `agent1qgppdeqca6sgqvljm0xg4sg4c9at3rjym2kjjaaxx4h6kh4zhegecew9x8c` | Picks stale competitor pages and review sources, refreshes them, reports brand and competitor intel |
| Ad Lab Strategist | `agent1qwtcefe5kjt0tlwdy6fkg4zx94wcnzzx63gw0f52kgl2lep52arp796dgqw` | Checks the recipes, queues the rounds on the task board, reports each round, declares winners |
| Ad Lab Copywriter | `agent1qwqcwufn0jz3a6plkv3arsef6htm6gwntvw5607wmuxepyw5alyvuwxmqjf` | Claims each round's creative task, chooses the learnings to apply, writes the next round's ads |

Ad Lab keeps `AD_LAB_AGENT_SEED`, so its address and Agentverse registration carry over from `hello_agent.py`. Each agent's Agentverse profile is in `profiles/`.

## The loop

1. You ask Ad Lab: "find ads that beat Magic Spoon's current ones". It acknowledges at once and asks Scout for intel.
2. Scout plans a refresh (`/ingest/refresh` dry, then the stalest targets) and reports; Ad Lab posts the **brand profile** and **competitor winners** cards.
3. Strategist checks the recipes (`/contract/build`) and plans the run; Ad Lab posts the **recipes** card.
4. You tap **Start the run** (or say "go"). Strategist queues round 0 (`/rounds/start`); B's sim worker claims it.
5. After each round the Copywriter claims the `generate_creatives` task (`/creatives/generate`), and Strategist reports the round; Ad Lab posts a **leaderboard** card per round.
6. After the last round Ad Lab posts the **winning ads per segment** and ends the session.

Say **status** at any time for the latest card. Each database holds one run: a new run needs a reset database (`npm run bench:reset:local`).

## Run

```
npm run agents                    # one Bureau on port 8001 (ADLAB_AGENTS_PORT), four mailbox agents
npm run agents:addresses          # the four agent1q… addresses; no network calls
```

`npm run agents` waits for `GET /health`, then keeps each agent's storage under `data/agents/<db_name>/`. Start the API and workers first, with the database set by their scripts (for example `npm run dev:local`, `npm run sim:worker:local`, and `npm run a5:worker:local` as the creative fallback).

**Never run `npm run agent` (hello_agent.py) together with `npm run agents`:** both use `AD_LAB_AGENT_SEED`, which would put two mailbox clients on one address.

## Register a new agent on Agentverse (once each)

1. Generate its seed into `.env.local`: `python3 -c "import secrets;print(secrets.token_hex(32))"` for each of `SCOUT_AGENT_SEED`, `STRATEGIST_AGENT_SEED` and `COPYWRITER_AGENT_SEED`.
2. `npm run agents:solo -- scout` runs Scout alone on port 8002 and prints its inspector URL (Strategist uses 8003, Copywriter 8004).
3. Open the URL while signed in to Agentverse, click **Connect**, choose **Mailbox**, and wait for `Successfully registered as mailbox agent in Agentverse`. Then press Ctrl-C.
4. Repeat for `strategist` and `copywriter`. Fill each profile from `profiles/<agent_id>.md` (description, both badges, Innovation Lab category).
5. Run `npm run agents:addresses` and paste the addresses into the table above.

Ad Lab is already registered. To chat, open its Agentverse profile and click **Chat with Agent**.

## Test

```
npm run agents:test                                   # unit tests, offline
npm run agents:e2e -- --fake-api --rounds 2           # full choreography against the in-memory FakeApi
npm run agents:e2e -- --fake-api --approve prose      # approve by typing "Start the run" (also: --approve json)
npm run agents:e2e -- --rounds 2                      # against the real API (dev:local, sim and A5 workers)
```

The e2e runs offline: derived seeds (never the registered addresses), no mailbox, no Almanac calls, Bureau on port 8010. A fake ASI:One user asks Ad Lab, approves the recipes card with a card response, pulls "status" after the first leaderboard, and checks the card order, the task board (every `tsk_gen` claimed by `copywriter`), and that every hop was logged. Against the real API it refuses unless `/health` says mode `test`, runs allowed, a free run slot, and a local database (`--allow-remote` allows `adlab-live`). Reports land in `data/agents/e2e-<ts>.json`.

## Environment

| Key | Default | Used for |
| --- | --- | --- |
| `AD_LAB_AGENT_SEED` | required | Ad Lab's identity (kept from hello_agent) |
| `SCOUT_AGENT_SEED`, `STRATEGIST_AGENT_SEED`, `COPYWRITER_AGENT_SEED` | required for `npm run agents` | the three new identities |
| `ADLAB_API_URL` | `http://localhost:3000/api/agent` | the Next API |
| `ADLAB_AGENTS_PORT` | `8001` | the Bureau's port |
| `STRATEGIST_ROUNDS_PLANNED` | `3` | rounds per run, 1-5 ("2 rounds" in the request overrides it) |
| `ADLAB_PAYMENT` | `0` | the Payment Protocol is cut; the flag stays off |
