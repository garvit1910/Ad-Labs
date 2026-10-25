import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';

// One /sim view: a titled card with a short hint on the right.
export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-3 px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </Card>
  );
}
