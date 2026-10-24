/**
 * Constants for dashboard chart components
 * Uses CSS variables for theme-aware styling
 */

import type { CSSProperties } from 'react';

/**
 * Chart color palette, mapped onto the per-metric chart tokens in app/globals.css
 * (--chart-1 accent, -2 violet, -3 teal, -4 ochre, -5 baseline grey) so it follows
 * the theme. Revenue is the key series and takes the accent. Platform-split charts
 * use PLATFORM_COLORS (lib/platforms/colors.ts) instead, never these.
 */
export const CHART_COLORS = {
  spend: 'var(--chart-2)',
  revenue: 'var(--chart-1)',
  clicks: 'var(--chart-3)',
  trend: 'var(--chart-5)',
  positive: 'var(--status-success)',
  leads: 'var(--chart-3)',
  traffic: 'var(--chart-3)',
  orange: 'var(--chart-4)',
} as const;

/** Tooltip styles with solid background (CSS variables keep it theme-aware) */
export const TOOLTIP_CONTENT_STYLE: CSSProperties = {
  backgroundColor: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  color: 'var(--popover-foreground)',
  padding: '8px 12px',
  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
};

/** Tooltip label styles */
export const TOOLTIP_LABEL_STYLE: CSSProperties = {
  color: 'var(--muted-foreground)',
};

/** Tooltip wrapper styles for z-index */
export const TOOLTIP_WRAPPER_STYLE: CSSProperties = {
  zIndex: 1000,
};

/** Common chart margins */
export const CHART_MARGINS = {
  default: { top: 5, right: 5, left: 5, bottom: 5 },
  dualAxis: { top: 10, right: 50, left: 50, bottom: 10 },
} as const;

/** Default axis tick fill using CSS variable reference */
export const AXIS_TICK_STYLE = {
  fill: 'currentColor',
} as const;

/** Gradient definitions for area charts */
export const CHART_GRADIENTS = {
  spend: {
    id: 'colorSpend',
    startColor: 'var(--chart-2)',
    startOpacity: 0.8,
    endOpacity: 0,
  },
  conversions: {
    id: 'colorConversions',
    startColor: 'var(--chart-3)',
    startOpacity: 0.8,
    endOpacity: 0,
  },
} as const;

/** Line stroke widths */
export const STROKE_WIDTH = {
  default: 2,
  trend: 2,
} as const;

/** Active dot configuration */
export const ACTIVE_DOT_CONFIG = {
  r: 4,
  cursor: 'pointer' as const,
};

/** Legend wrapper styles */
export const LEGEND_WRAPPER_STYLE: CSSProperties = {
  paddingTop: '10px',
};

