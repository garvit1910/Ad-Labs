'use client';

import { ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { type MessageView, clockTime, prettyPayload } from '../_lib/selectors';

// Every agent_message row, newest first: time, from -> to, kind, protocol, summary, and the
// payload behind a <details>.
export function MessageStream({ messages, empty }: { messages: readonly MessageView[]; empty: string }) {
  if (messages.length === 0) return <div className="py-6 text-center text-sm text-muted-foreground">{empty}</div>;
  return (
    <ul className="flex max-h-[520px] flex-col divide-y divide-border overflow-y-auto">
      {messages.map((m) => (
        <li key={m.messageId} className="py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono tabular-nums text-muted-foreground" title={new Date(m.createdMs).toISOString()}>
              {clockTime(m.createdMs)}
            </span>
            <span className="inline-flex items-center gap-1 font-medium">
              {m.fromName}
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              {m.toName}
            </span>
            <Badge variant="outline" className="px-1.5 py-0 text-[10.5px]">
              {m.kind}
            </Badge>
            <span className="font-mono text-[10.5px] text-muted-foreground">{m.protocol}</span>
            {m.runId && <span className="font-mono text-[10.5px] text-muted-foreground">{m.runId}</span>}
          </div>
          <div className="mt-0.5 text-foreground">{m.summary}</div>
          {m.payload && m.payload !== '{}' && (
            <details className="mt-1">
              <summary className="cursor-pointer select-none text-[11px] text-muted-foreground hover:text-foreground">payload</summary>
              <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-background/50 p-2 font-mono text-[10.5px] leading-relaxed">
                {prettyPayload(m.payload)}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}
