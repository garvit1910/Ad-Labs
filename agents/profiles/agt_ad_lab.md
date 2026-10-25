# Ad Lab

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

**Finds ads that beat Magic Spoon's current ones, by testing ad recipes on 300 simulated shoppers.**

Ad Lab is the agent you talk to in ASI:One. It runs the whole test by delegating to three helper agents, and turns every hop between them into a one-line update and an Interactive Card:

1. **Scout** checks which competitor pages and review sources are stale, refreshes them, and reports what Magic Spoon's customers say and which competitor ads keep running. Ad Lab shows the **brand profile** and **competitor winners** cards.
2. **Strategist** builds the ad recipes (angle × hook) and the test plan. Ad Lab shows the **recipes** card; tap **Start the run** (or say "go") to begin.
3. The rounds run on simulated shoppers. After each round the **Copywriter** writes new ads from what the shoppers taught us, and Ad Lab posts that round's **leaderboard** card.
4. When the rounds are done, Ad Lab posts the **winning ads per segment**.

## Try it

- "find ads that beat Magic Spoon's current ones"
- "go" / "not now" once the recipes card arrives
- "status" at any time, for the latest card

## Protocols

AgentChatProtocol 0.3.0 with Interactive Cards (detail, carousel, review). Typed protocols with the other agents: AdLabIntel, AdLabProgress, AdLabPlan, AdLabRun.

Built for Cal Hacks 13.0 with Fetch.ai uAgents.
