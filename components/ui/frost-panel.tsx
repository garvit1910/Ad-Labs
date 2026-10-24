import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * FrostPanel: the page/workflow container (`.panel-frost`). A flat card surface
 * with a hairline border and the quiet neutral shadow (no gradient, no orbs). It
 * is the standard app-wide page shell: page content sits inside a FrostPanel.
 *
 * - `fill` — make the panel grow to fill a full-height (`h-screen`/flex) parent
 *   and let its content scroll internally. Use on app pages like dashboard,
 *   assets, ads-manager, analytics, ask-adcero.
 * - `contentClassName` — override the inner content wrapper (padding / gap / flex).
 * - `padded={false}` — remove the default `p-6` (for panels whose children own
 *   their own padding, e.g. a full-bleed table or chat transcript).
 */
interface FrostPanelProps extends React.ComponentProps<"div"> {
  fill?: boolean;
  padded?: boolean;
  contentClassName?: string;
}

export function FrostPanel({
  fill = false,
  padded = true,
  className,
  contentClassName,
  children,
  ...props
}: FrostPanelProps) {
  return (
    <div
      className={cn(
        "panel-frost",
        fill && "flex min-h-0 flex-1 flex-col",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "relative flex flex-col gap-5",
          padded && "p-6",
          fill && "min-h-0 flex-1",
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
