import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * EyebrowChip: the header counter chip. Used for right-aligned header
 * annotations like "3 selected · ~12 steps" or "Extension detected · v1.2.0".
 * Renders `.eyebrow-chip`: accent-soft fill with accent text.
 */
interface EyebrowChipProps {
  children: React.ReactNode;
  /** Optional leading lucide icon. */
  icon?: LucideIcon;
  className?: string;
}

export function EyebrowChip({ children, icon: Icon, className }: EyebrowChipProps) {
  return (
    <span className={cn("eyebrow-chip", className)}>
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </span>
  );
}
