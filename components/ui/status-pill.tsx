import * as React from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * StatusPill: the canonical 6-tone lifecycle indicator.
 * Use this instead of ad-hoc badge variants for connection / setup / job state.
 * Connected, paused and failed use the status tokens (--status-*); active,
 * queued and not set stay neutral. The brand accent never colours a status
 * (tasks/magenta-charcoal-palette-plan.md, rule 4).
 */
export type StatusPillTone =
  | "connected"
  | "active"
  | "paused"
  | "failed"
  | "queued"
  | "not_set";

const TONE_CLASSES: Record<StatusPillTone, string> = {
  connected: "bg-status-success-soft text-status-success border-status-success/30",
  active: "bg-secondary text-foreground border-border",
  paused: "bg-status-warning-soft text-status-warning border-status-warning/30",
  failed: "bg-status-error-soft text-status-error border-status-error/30",
  queued: "bg-transparent text-muted-foreground border-dashed border-border",
  not_set: "bg-transparent text-muted-foreground border-border",
};

const DOT_CLASSES: Record<StatusPillTone, string> = {
  connected: "bg-status-success",
  active: "bg-foreground",
  paused: "bg-status-warning",
  failed: "bg-status-error",
  queued: "bg-muted-foreground",
  not_set: "bg-muted-foreground/40",
};

/** Default label per tone: `Shell.statusPill.<key>`. */
const DEFAULT_LABEL_KEY = {
  connected: "connected",
  active: "active",
  paused: "paused",
  failed: "failed",
  queued: "queued",
  not_set: "notSet",
} as const satisfies Record<StatusPillTone, string>;

interface StatusPillProps {
  tone: StatusPillTone;
  /** Overrides the default label for the tone. */
  children?: React.ReactNode;
  /** Hide the leading color dot. */
  hideDot?: boolean;
  className?: string;
}

export function StatusPill({
  tone,
  children,
  hideDot = false,
  className,
}: StatusPillProps) {
  const t = useTranslations("Shell.statusPill");
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {!hideDot && (
        <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASSES[tone])} />
      )}
      {children ?? t(DEFAULT_LABEL_KEY[tone])}
    </span>
  );
}
