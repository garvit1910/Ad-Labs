# Ad Lab Scout

![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

**Brand and competitor intelligence for Ad Lab: decides what's stale, refreshes it on Apify, and summarizes what customers say.**

Scout is one of Ad Lab's four agents. When Ad Lab asks for intel, Scout:

- lists every Meta ad library page and review source with its last sync time, and picks the stalest ones (pages older than 6 hours, sources older than 12, never-synced first);
- refreshes those through the Ad Lab job queue, which runs the Apify actors (in test mode the refresh is planned and logged, not run);
- reports Magic Spoon's top customer pains, desires and objections with quotes, the competitors' longest-running ads, and the recurring creative patterns.

## Ask it directly

- "what do Magic Spoon's customers complain about?"
- "which competitor ads are winning?"

## Protocols

AgentChatProtocol 0.3.0; AdLabIntel (receives IntelRequest, replies IntelReport) and AdLabProgress.

Built for Cal Hacks 13.0 with Fetch.ai uAgents.
