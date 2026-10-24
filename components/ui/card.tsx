import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Card variants (Magenta & Charcoal flat surfaces, tasks/magenta-charcoal-palette-plan.md):
 * - `frost` (default): `.frost-card`, the app-wide section card: `bg-card`, hairline
 *   `border-border`, quiet neutral `shadow-surface`. (Name kept from the retired glass look.)
 * - `subtle`: `.frost-card-subtle`, the same surface without the shadow, for dense data.
 * - `plain`: solid `bg-card` + neutral border, for platform create-modals.
 * Add `.platform-tint-card` (with --platform-tint) for a platform-scoped card.
 */
type CardVariant = "frost" | "subtle" | "plain"

const CARD_VARIANTS: Record<CardVariant, string> = {
  frost: "frost-card",
  subtle: "frost-card-subtle",
  plain: "bg-card border border-neutral-200 dark:border-border",
}

function Card({
  className,
  variant = "frost",
  ...props
}: React.ComponentProps<"div"> & { variant?: CardVariant }) {
  return (
    <div
      data-slot="card"
      className={cn(
        "text-card-foreground flex flex-col gap-6 rounded-xl py-6",
        CARD_VARIANTS[variant],
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-6", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props}
    />
  )
}

export {
  Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle
}

