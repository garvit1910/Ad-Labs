"""Ad Lab hello-world uAgent: chat protocol, Agentverse mailbox, reachable from ASI:One.

Follows Fetch's "Create an ASI:One Compatible Agent Using the Chat Protocol" guide
(uagents 0.25.5, AgentChatProtocol 0.3.0). A6 grows this into the real Ad Lab agent; it keeps
the same seed, so the agent1q... address and its Agentverse registration carry over.

Run from the repo root: npm run agent
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)

# Secrets live only in the repo-root .env.local.
load_dotenv(Path(__file__).resolve().parent.parent / ".env.local")

seed = os.getenv("AD_LAB_AGENT_SEED")
if not seed:
    raise RuntimeError("AD_LAB_AGENT_SEED is not set in .env.local")

agent = Agent(
    name="Ad Lab",
    seed=seed,
    port=8001,
    mailbox=True,
    publish_agent_details=True,
)

protocol = Protocol(spec=chat_protocol_spec)


@protocol.on_message(ChatMessage)
async def handle_message(ctx: Context, sender: str, msg: ChatMessage):
    # Acknowledge every message first, as the chat protocol requires.
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))

    text = ""
    for item in msg.content:
        if isinstance(item, StartSessionContent):
            ctx.logger.info(f"Session started by {sender}")
        elif isinstance(item, TextContent):
            text += item.text
        elif isinstance(item, EndSessionContent):
            ctx.logger.info(f"Session ended by {sender}")
    if not text:
        return

    ctx.logger.info(f"Received from {sender}: {text!r}")
    reply = (
        "Ad Lab is online. I test Magic Spoon ad recipes on simulated shoppers; "
        f"for now I only say hello. You said: {text}"
    )
    await ctx.send(
        sender,
        ChatMessage(
            content=[
                TextContent(type="text", text=reply),
                EndSessionContent(type="end-session"),
            ]
        ),
    )


@protocol.on_message(ChatAcknowledgement)
async def handle_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    ctx.logger.debug(f"{sender} acknowledged {msg.acknowledged_msg_id}")


# publish_manifest=True lets Agentverse and ASI:One see that this agent speaks the chat protocol.
agent.include(protocol, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
