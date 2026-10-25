# Ad Lab Copywriter

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

**Writes each round's new ads for Ad Lab from what the simulated shoppers taught us.**

Copywriter is one of Ad Lab's four agents. After every round, the shopper simulation posts a creative task: which recipes need new ads, for which segments, and which learnings came out of the round (claims shoppers doubt, objections, winners). The Copywriter:

- claims that task within seconds;
- chooses which learnings to apply: at most three per segment, the recipe's own winner first, then doubted claims, then objections, and never a directive with a number in it;
- writes the variants through Ad Lab's creative engine, then queues the next round;
- retries a failed write three times (after 20, 40 and 80 seconds) before giving up, and stands down if the fallback worker took the task.

## Ask it directly

- "what did you write last round?"

## Protocols

AgentChatProtocol 0.3.0; AdLabRun (receives RunStarted, RunFinished, RunFailed), AdLabCreatives (sends CreativesWritten), AdLabProgress.

Built for Cal Hacks 13.0 with Fetch.ai uAgents.
