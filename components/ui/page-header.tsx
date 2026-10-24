import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * PageHeader — the canonical Adcero page heading.
 *
 * Matches the Attribution standard: a bold tracking-tight title, an optional
 * muted subtitle, and a right-aligned actions slot (tour button, primary CTA,
 * mode switchers). Use this on every page instead of hand-rolling an
 * `<h1>` + subtitle block so the heading rhythm stays consistent app-wide.
 * Titles are always solid foreground text: the brand accent is reserved for the
 * primary action and the one key figure on a screen.
 */
interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Optional eyebrow row above the title (e.g. an icon chip or breadcrumb). */
  eyebrow?: React.ReactNode;
  /** Right-aligned controls: tour button, primary CTA, tabs/mode switcher. */
  actions?: React.ReactNode;
  className?: string;
  /** Override the title element classes (defaults to the page-title scale). */
  titleClassName?: string;
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
  titleClassName,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && <div className="mb-2">{eyebrow}</div>}
        <h1
          className={cn(
            "text-2xl font-bold tracking-tight sm:text-3xl",
            titleClassName,
          )}
        >
          {title}
        </h1>
        {description && (
          <div className="text-muted-foreground mt-2 max-w-2xl text-sm">
            {description}
          </div>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
