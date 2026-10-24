'use client';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { SegmentRow } from '@/lib/spacetime/bindings/types';
import type { LearningItem } from '../_lib/selectors';
import { parseJson, words } from '../_lib/format';

// What the sim learned, newest first. A learning stays live until a later round replaces it; each
// one lists the creatives whose learning_ids name it (written by A's creative worker).
export function LearningsFeed({ items, segments }: { items: LearningItem[]; segments: readonly SegmentRow[] }) {
  if (items.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No learnings yet: the first ones land when round 0 ends.</p>;
  const segmentName = new Map(segments.map((s) => [s.segmentId, s.name]));
  return (
    <div className="max-h-[520px] overflow-y-auto pr-1">
      <ul className="flex flex-col">
        {items.map((l) => {
          const evidence = parseJson<Record<string, unknown>>(l.evidence, {});
          const n = evidence.n ?? evidence.page_calls ?? evidence.impressions;
          return (
            <li key={l.learningId} className={cn('flex flex-col gap-1 border-t border-border/60 py-2.5', !l.live && 'opacity-55')}>
              <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
                <Badge variant="outline" className="text-[10px]">{words(l.kind)}</Badge>
                <span className="text-muted-foreground">{segmentName.get(l.segmentId) ?? l.segmentId}</span>
                <span className="font-mono text-muted-foreground">
                  · round {l.validFromRound}
                  {l.validToRound !== undefined ? `–${l.validToRound}` : '+'}
                </span>
                {l.live ? <Badge variant="secondary" className="text-[10px]">live</Badge> : <span className="text-muted-foreground">replaced</span>}
                {typeof n === 'number' && <span className="font-mono text-muted-foreground">· n={n}</span>}
              </div>
              <p className="text-sm text-foreground">{l.statement}</p>
              <p className="text-xs text-muted-foreground">→ {l.directive}</p>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                {l.usedBy.length === 0 ? (
                  <span className="text-muted-foreground/70">No creative has used it yet.</span>
                ) : (
                  <>
                    <span className="text-muted-foreground">Used by</span>
                    {l.usedBy.map((c) => (
                      <span key={c.creativeId} className="rounded-md border border-border bg-secondary/50 px-1.5 py-0.5" title={c.creativeId}>
                        {c.headline} <span className="font-mono text-muted-foreground">r{c.roundCreated}</span>
                      </span>
                    ))}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
