'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HeartPulse } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  CHART_MARGINS,
  TOOLTIP_CONTENT_STYLE,
} from '@/components/dashboard/charts/constants';
import { SURVIVAL_MAX_DAYS, type DeskAnalysis } from '@/lib/brand-identity/desk';

/**
 * Survival curve - the share of the competitor's ads still active at each age
 * (0–90d), right-censored so young still-running ads don't distort late-day
 * survival. A reference line marks the median longevity when computable.
 *
 * Recharts-backed → imported ONLY via components/brand-identity/DynamicPanels.tsx
 * (never statically from a first-paint-reachable component).
 */
export function SurvivalCurveChart({
  survival,
}: {
  survival: DeskAnalysis['survival'];
}) {
  const { points, medianDays } = survival;
  const t = useTranslations('BrandIdentity.desk.survival');

  return (
    <Card className="h-full border-neutral-200/80 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-emerald-500" />
            {t('title')}
          </span>
          {medianDays != null && (
            <span className="text-xs font-normal text-muted-foreground">
              {t('median', { days: Math.round(medianDays) })}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-40 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={CHART_MARGINS.default}>
              <CartesianGrid
                strokeDasharray="3 3"
                className="stroke-muted"
                vertical={false}
              />
              <XAxis
                dataKey="day"
                type="number"
                domain={[0, SURVIVAL_MAX_DAYS]}
                ticks={[0, 30, 60, 90]}
                tickFormatter={(v: number) => t('days', { days: v })}
                className="text-xs"
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                domain={[0, 1]}
                tickFormatter={(v: number) => t('pct', { value: v })}
                className="text-xs"
                tickLine={false}
                axisLine={false}
                width={36}
              />
              <Tooltip
                contentStyle={TOOLTIP_CONTENT_STYLE}
                formatter={(value: number) => [
                  t('stillActive', { value }),
                  t('title'),
                ]}
                labelFormatter={(label: number) => t('atDays', { days: label })}
              />
              {medianDays != null && (
                <ReferenceLine
                  x={Math.round(medianDays)}
                  stroke="#10b981"
                  strokeDasharray="4 4"
                  label={{
                    value: t('median', { days: Math.round(medianDays) }),
                    position: 'insideTopRight',
                    fontSize: 10,
                    fill: '#10b981',
                  }}
                />
              )}
              <Line
                type="monotone"
                dataKey="aliveShare"
                stroke="var(--chart-1)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
