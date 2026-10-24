# Ad Lab agents (Fetch.ai uAgents)

Python 3.12 managed by uv, with `uagents==0.25.5` (AgentChatProtocol 0.3.0).

## Run

From the repo root (needs `AD_LAB_AGENT_SEED` in `.env.local`):

```
npm run agent
```

That runs `uv run --project agents python agents/hello_agent.py`, on port 8001.

## First-time Agentverse and ASI:One setup

1. Start the agent and copy the inspector URL from the log (`Agent inspector available at https://agentverse.ai/inspect/...`).
2. Open it while signed in to Agentverse, then click **Connect** and choose **Mailbox**. The log should then show `Successfully registered as mailbox agent in Agentverse`.
3. In Agentverse, open the agent's profile and click **Chat with Agent**. That opens ASI:One chat. Send any message; the agent replies "Ad Lab is online…".

The mailbox queues messages while the agent is offline, so the registration survives restarts. The seed fixes the `agent1q…` address.
