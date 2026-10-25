import { cn } from '@/lib/utils';
import { partyStyle } from '../_lib/chat';

const DOT: Record<string, string> = {
  idle: 'bg-status-success',
  working: 'bg-sky-400 animate-pulse',
  error: 'bg-status-error',
};

// A party's coloured initials, with an optional status dot (idle / working / error / not started).
export function PartyAvatar({ id, status, size = 'md', className }: { id: string; status?: string; size?: 'sm' | 'md'; className?: string }) {
  const style = partyStyle(id);
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold ring-1',
        size === 'sm' ? 'size-6 text-[9px]' : 'size-9 text-[11px]',
        style.className,
        className,
      )}
    >
      {style.initials}
      {status !== undefined && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card',
            DOT[status] ?? 'bg-muted-foreground/40',
          )}
        />
      )}
    </span>
  );
}
