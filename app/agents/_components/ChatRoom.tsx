import type { ReactNode } from 'react';

// The three-pane room shell: sessions | thread | participants, one bordered card at screen height.
export function ChatRoom({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-[calc(100vh-17rem)] min-h-[560px] grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[250px_minmax(0,1fr)_300px] lg:grid-rows-1">
      {children}
    </div>
  );
}
