# Ad Lab Strategist

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

**Plans and runs Ad Lab's ad tests: recipes, rounds on the task board, results and winners.**

Strategist is one of Ad Lab's four agents. It:

- checks the ad recipes (angle × hook per strategy, plus Magic Spoon's current ads as the control) and that round 0's ads are ready, then proposes a plan: how many rounds, which database, which run id;
- refuses to plan a run on a protected database or on one that already holds a run (one run per database);
- on the user's go, queues round 0 on the shared task board, where the shopper simulation picks it up;
- watches every round, reports each leaderboard, warns when a worker is missing or a round is stuck, and declares a winner per shopper segment once the evidence is clear.

## Ask it directly

- "status" during a run
- "what's the plan?" for the last recipes

## Protocols

AgentChatProtocol 0.3.0; AdLabPlan (PlanRequest → RecipePlan), AdLabRun (StartRun → RunStarted, RoundResult, RunFinished, RunFailed), AdLabCreatives, AdLabProgress.

Built for Cal Hacks 13.0 with Fetch.ai uAgents.
