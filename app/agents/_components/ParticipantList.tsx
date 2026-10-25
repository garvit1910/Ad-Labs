'use client';

import { type ReactNode, useState } from 'react';
import { Check, Copy, Crown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { tidy } from '../_lib/chat';
import { type AgentCardView, USER_NAME, shortAddress } from '../_lib/selectors';
import { PartyAvatar } from './PartyAvatar';

// The room's right rail: you, then the four agents with status, current step and agent1… address.
export function ParticipantList({ agents }: { agents: readonly AgentCardView[] }) {
  return (
    <aside className="hidden min-h-0 flex-col border-l border-border lg:flex">
      <div className="flex h-14 shrink-0 items-center border-b border-border px-4 text-sm font-semibold">Participants</div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        <Group title="Users">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-background/40 px-3 py-2.5">
            <PartyAvatar id="user" />
            <div className="min-w-0">
              <div className="text-sm font-medium">{USER_NAME}</div>
              <div className="text-xs text-muted-foreground">Chatting with Ad Lab on ASI:One</div>
            </div>
          </div>
        </Group>
        <Group title="Agents">
          {agents.map((a) => (
            <AgentRow key={a.agentId} agent={a} />
          ))}
        </Group>
      </div>
    </aside>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="px-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      {children}
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentCardView }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(agent.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the full address is in the title.
    }
  };
  const working = agent.status === 'working';
  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border border-border bg-background/40 px-3 py-2.5', agent.placeholder && 'opacity-60')}>
      <div className="flex items-start gap-3">
        <PartyAvatar id={agent.agentId} status={agent.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{agent.name}</span>
            {agent.agentId === 'agt_ad_lab' && <Crown className="size-3.5 shrink-0 text-violet-300" aria-label="orchestrator" />}
          </div>
          <div className="line-clamp-2 text-xs text-muted-foreground">{agent.role}</div>
        </div>
      </div>
      <div className={cn('line-clamp-2 text-xs', working ? 'text-sky-300' : 'text-muted-foreground')}>
        {agent.placeholder ? 'Not started yet' : working ? `● ${tidy(agent.currentStep) || 'working'}` : tidy(agent.currentStep) || 'Idle'}
      </div>
      <div className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
        {agent.address ? (
          <button type="button" onClick={copy} title={agent.address} className="inline-flex min-w-0 items-center gap-1 font-mono hover:text-foreground">
            <span className="truncate">{shortAddress(agent.address)}</span>
            {copied ? <Check className="size-3 shrink-0" /> : <Copy className="size-3 shrink-0" />}
          </button>
        ) : (
          <span className="font-mono">no address yet</span>
        )}
        <span className="shrink-0">Agentverse · Mailbox</span>
      </div>
    </div>
  );
}
