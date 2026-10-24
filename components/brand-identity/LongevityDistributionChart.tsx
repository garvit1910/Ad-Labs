'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useTranslations, type Messages } from 'next-intl';
import {
  CHART_MARGINS,
  TOOLTIP_CONTENT_STYLE,
} from '@/components/dashboard/charts/constants';

const BUCKET_COLORS: Record<string, string> = {
  lt14: '#94a3b8',
  d14_30: '#3b82f6',
  d30_60: '#f59e0b',
  winner: '#10b981',
};

type BucketLabelKey = keyof Messages['BrandIdentity']['longevity']['buckets'];

export function LongevityDistributionChart({
  distribution,
}: {
  distribution: Array<{ bucket: string; label: string; count: number }>;
}) {
  const t = useTranslations('BrandIdentity.longevity');
  // The server sends English bucket labels; render the catalog label by key.
  const data = distribution.map((entry) => ({
    ...entry,
    label: t.has(`buckets.${entry.bucket as BucketLabelKey}`)
      ? t(`buckets.${entry.bucket as BucketLabelKey}`)
      : entry.label,
  }));
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={CHART_MARGINS.default}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
          <XAxis dataKey="label" className="text-xs" tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} className="text-xs" tickLine={false} axisLine={false} width={32} />
          <Tooltip
            contentStyle={TOOLTIP_CONTENT_STYLE}
            cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
            formatter={(value: number) => [t('tooltipAds', { count: value }), t('tooltipCount')]}
          />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {distribution.map((entry) => (
              <Cell
                key={entry.bucket}
                fill={BUCKET_COLORS[entry.bucket] ?? '#94a3b8'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
