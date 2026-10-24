'use client';

/**
 * Translated labels for the Brand Presence enums whose English constants live
 * in shared, non-UI modules (`SOURCE_REGISTRY`, `STATUS_LABEL`,
 * `PRESENCE_ROLE_LABELS`, `KIND_META`, the mention pills). The English
 * constants stay as they are for their non-React consumers and tests; React
 * render sites read the catalog through these hooks. Each hook maps an id to
 * a leaf key through a typed `Record`, so no template-literal keys are built.
 */
import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type {
  BrandPresenceSource,
  BrandPresenceSourceType,
  MentionAngle,
  MentionDataType,
  MentionRelevance,
  MentionSentiment,
  MentionScope,
  PhraseKind,
  PresenceRole,
  ThemeKind,
} from '@/lib/brand-presence/types';
import { SOURCE_REGISTRY } from '@/lib/brand-presence/source-registry';
import type { SourceDisplayStatus } from './SourceCard';

/** A subreddit's display name ("r/skincare") — a Reddit identifier, never
 * translated. */
export function subredditLabel(name: string): string {
  return `r/${name}`;
}

const SOURCE_STATUS_KEYS = {
  synced: 'synced',
  running: 'running',
  pending: 'pending',
  awaiting_confirm: 'awaitingConfirm',
  error: 'error',
  available: 'available',
  coming_soon: 'comingSoon',
} as const satisfies Record<SourceDisplayStatus, string>;

/** `STATUS_LABEL` in the user's language; unknown statuses render raw. */
export function useSourceStatusLabel(): (_status: string) => string {
  const t = useTranslations('BrandPresence.sourceStatus');
  return useCallback(
    (status: string) => {
      const key = SOURCE_STATUS_KEYS[status as SourceDisplayStatus];
      return key ? t(key) : status;
    },
    [t],
  );
}

/** The Console rail's status label: `available` reads "Not set up" and
 * `running` reads "Reading"; everything else is the canonical label. */
export function useConsoleStatusLabel(): (_status: SourceDisplayStatus) => string {
  const t = useTranslations('BrandPresence.sourceStatus');
  const statusLabel = useSourceStatusLabel();
  return useCallback(
    (status: SourceDisplayStatus) =>
      status === 'available'
        ? t('notSetUp')
        : status === 'running'
          ? t('reading')
          : statusLabel(status),
    [t, statusLabel],
  );
}

const SOURCE_TYPE_KEYS = {
  reddit_search: 'redditSearch',
  reddit_subreddit: 'redditSubreddit',
  reddit_category: 'redditCategory',
  amazon_reviews: 'amazonReviews',
  google_maps_reviews: 'googleMapsReviews',
  instagram_comments: 'instagramComments',
  tiktok_comments: 'tiktokComments',
  trustpilot: 'trustpilot',
  onsite_reviews: 'onsiteReviews',
  youtube: 'youtube',
  x: 'x',
} as const satisfies Record<BrandPresenceSourceType, string>;

/** `SOURCE_REGISTRY` label + description in the user's language. */
export function useSourceTypeCopy(): {
  label: (_type: BrandPresenceSourceType) => string;
  description: (_type: BrandPresenceSourceType) => string;
} {
  const tLabel = useTranslations('BrandPresence.sourceLabels');
  const tDescription = useTranslations('BrandPresence.sourceDescriptions');
  const label = useCallback(
    (type: BrandPresenceSourceType) => tLabel(SOURCE_TYPE_KEYS[type]),
    [tLabel],
  );
  const description = useCallback(
    (type: BrandPresenceSourceType) => tDescription(SOURCE_TYPE_KEYS[type]),
    [tDescription],
  );
  return { label, description };
}

/**
 * A source row's display label. A custom `label` is user/pipeline data and
 * renders as stored, unless it is just the registry's English default — then
 * the translated registry label is shown.
 */
export function useSourceDisplayLabel(): (
  _source: Pick<BrandPresenceSource, 'label' | 'source_type'>,
) => string {
  const { label } = useSourceTypeCopy();
  return useCallback(
    (source: Pick<BrandPresenceSource, 'label' | 'source_type'>) => {
      const registryLabel = SOURCE_REGISTRY[source.source_type]?.label;
      if (source.label && source.label !== registryLabel) return source.label;
      return SOURCE_TYPE_KEYS[source.source_type]
        ? label(source.source_type)
        : (source.label ?? source.source_type);
    },
    [label],
  );
}

const ROLE_KEYS = {
  self: 'self',
  competitor: 'competitor',
} as const satisfies Record<PresenceRole, string>;

/** `PRESENCE_ROLE_LABELS` in the user's language. */
export function usePresenceRoleLabel(): (_role: PresenceRole) => string {
  const t = useTranslations('BrandPresence.roles');
  return useCallback((role: PresenceRole) => t(ROLE_KEYS[role]), [t]);
}

const THEME_KIND_KEYS = {
  pain: 'pain',
  desire: 'desire',
  objection: 'objection',
  praise: 'praise',
} as const satisfies Record<ThemeKind, string>;

/** `KIND_META[kind].title` in the user's language; unknown kinds render raw. */
export function useThemeKindTitle(): (_kind: string) => string {
  const t = useTranslations('BrandPresence.themeKinds');
  return useCallback(
    (kind: string) => {
      const key = THEME_KIND_KEYS[kind as ThemeKind];
      return key ? t(key) : kind;
    },
    [t],
  );
}

const PHRASE_KIND_KEYS = {
  pain: 'pain',
  desire: 'desire',
  objection: 'objection',
  praise: 'praise',
  quote: 'quote',
} as const satisfies Record<PhraseKind, string>;

/** Singular phrase/theme kind ("pain", "quote"); unknown kinds render raw. */
export function usePhraseKindLabel(): (_kind: string) => string {
  const t = useTranslations('BrandPresence.phraseKinds');
  return useCallback(
    (kind: string) => {
      const key = PHRASE_KIND_KEYS[kind as PhraseKind];
      return key ? t(key) : kind;
    },
    [t],
  );
}

const DATA_TYPE_KEYS = {
  post: 'post',
  comment: 'comment',
  review: 'review',
} as const satisfies Record<MentionDataType, string>;

/** Singular mention data type ("post", "comment", "review"); unknown values
 * render raw. */
export function useMentionDataTypeLabel(): (_dataType: string) => string {
  const t = useTranslations('BrandPresence.dataTypeSingular');
  return useCallback(
    (dataType: string) => {
      const key = DATA_TYPE_KEYS[dataType as MentionDataType];
      return key ? t(key) : dataType;
    },
    [t],
  );
}

const ANGLE_KEYS = {
  pain_point: 'painPoint',
  praise: 'praise',
  wish: 'wish',
  question: 'question',
  comparison: 'comparison',
  other: 'other',
} as const satisfies Record<MentionAngle, string>;

/** `ANGLE_META[angle].label` in the user's language. */
export function useAngleLabel(): (_angle: MentionAngle) => string {
  const t = useTranslations('BrandPresence.angles');
  return useCallback((angle: MentionAngle) => t(ANGLE_KEYS[angle]), [t]);
}

const SENTIMENT_KEYS = {
  positive: 'positive',
  negative: 'negative',
  neutral: 'neutral',
  mixed: 'mixed',
} as const satisfies Record<MentionSentiment, string>;

/** Mention sentiment label; unknown values render raw. */
export function useSentimentLabel(): (_sentiment: string) => string {
  const t = useTranslations('BrandPresence.sentiments');
  return useCallback(
    (sentiment: string) => {
      const key = SENTIMENT_KEYS[sentiment as MentionSentiment];
      return key ? t(key) : sentiment;
    },
    [t],
  );
}

const SCOPE_KEYS = {
  brand: 'brand',
  competitor: 'competitor',
  category: 'category',
} as const satisfies Record<MentionScope, string>;

export function useMentionScopeLabel(): (_scope: MentionScope) => string {
  const t = useTranslations('BrandPresence.scopes');
  return useCallback((scope: MentionScope) => t(SCOPE_KEYS[scope]), [t]);
}

const RELEVANCE_KEYS = {
  relevant: 'relevant',
  pending: 'pending',
  not_required: 'notRequired',
  irrelevant: 'irrelevant',
} as const satisfies Record<MentionRelevance, string>;

export function useRelevanceLabel(): (_relevance: MentionRelevance) => string {
  const t = useTranslations('BrandPresence.relevance');
  return useCallback(
    (relevance: MentionRelevance) => t(RELEVANCE_KEYS[relevance]),
    [t],
  );
}
