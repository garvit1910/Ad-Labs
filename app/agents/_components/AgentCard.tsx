'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/status-pill';
import { cn } from '@/lib/utils';
import { type AgentCardView, shortAddress } from '../_lib/selectors';

// One agent: name, role, status pill, current step, its agent1… address and the last update.
export function AgentCard({ agent }: { agent: AgentCardView }) {
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
  return (
    <Card className={cn('gap-2 px-4 py-3.5', agent.placeholder && 'opacity-70')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight">{agent.name}</div>
          <div className="line-clamp-2 text-xs text-muted-foreground">{agent.role}</div>
        </div>
        <StatusPill tone={agent.tone}>{agent.statusLabel}</StatusPill>
      </div>
      <div className={cn('min-h-[2.5rem] text-xs', agent.currentStep ? 'text-foreground' : 'text-muted-foreground')}>
        {agent.placeholder ? 'Waiting for the agent to start and report its status.' : agent.currentStep || 'Idle.'}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
        {agent.address ? (
          <button
            type="button"
            onClick={copy}
            title={agent.address}
            className="inline-flex min-w-0 items-center gap-1 font-mono hover:text-foreground"
          >
            <span className="truncate">{shortAddress(agent.address)}</span>
            {copied ? <Check className="h-3 w-3 shrink-0" /> : <Copy className="h-3 w-3 shrink-0" />}
          </button>
        ) : (
          <span className="font-mono">no address yet</span>
        )}
        <span className="shrink-0 tabular-nums" title={agent.updatedMs ? new Date(agent.updatedMs).toISOString() : undefined}>
          {agent.placeholder ? 'not started' : `updated ${agent.updatedAgo}`}
          {!agent.placeholder && ` · ${agent.sent}↑ ${agent.received}↓`}
        </span>
      </div>
    </Card>
  );
}
