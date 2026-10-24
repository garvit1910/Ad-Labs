/**
 * CLIENT-SAFE merge of a translated theme label/summary (plan
 * `tasks/i18n-ai-output-translations-plan.md` WS6, content A6). Pure, ZERO imports —
 * hooks and `'use client'` components import this file directly; the server half is
 * `./theme-translation.server.ts`.
 *
 * The themes route attaches `localized: { locale, label, summary }` to a theme only
 * for a non-English viewer whose translation was ready. The merge uses it only when
 * its `locale` matches the viewer's CURRENT locale (a cached response from before a
 * language switch never shows the wrong language) and flags the theme
 * `aiTranslated: true` so the UI can show the "AI-translated" marker. Catch-all
 * themes carry deterministic English labels ("Other pains"); for a non-English viewer
 * they are swapped for the catalog label by `kind` (no AI involved, no marker).
 * WS8: `applyLocalizedLandscape` is the same merge for the competitive-landscape
 * response (screen, Brand Book, headless PDF), and `useGoogleMapsInsights` reuses
 * `applyLocalizedTheme` for the listing theme groups.
 */

export interface LocalizedThemeProse {
  locale: string;
  label: string;
  summary: string | null;
}

export interface LocalizableTheme {
  kind: string;
  label: string;
  summary: string | null;
  is_catchall: boolean;
  localized?: unknown;
}

/** `fr-CA` / `FR` → `fr`. */
function primaryLanguage(locale: string | null | undefined): string {
  return typeof locale === 'string' ? (locale.trim().toLowerCase().split(/[-_]/)[0] ?? '') : '';
}

function readLocalized(value: unknown): LocalizedThemeProse | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.locale !== 'string' || typeof record.label !== 'string' || record.label.trim() === '') {
    return null;
  }
  return {
    locale: record.locale,
    label: record.label,
    summary: typeof record.summary === 'string' ? record.summary : null,
  };
}

/**
 * The theme as the viewer should see it. English (or no usable translation) returns
 * the theme unchanged; a matching translation replaces `label`/`summary` and sets
 * `aiTranslated: true`; a catch-all gets `catchallLabel(kind)` when one is given.
 */
export function applyLocalizedTheme<T extends LocalizableTheme>(
  theme: T,
  viewerLocale: string | null | undefined,
  catchallLabel?: (_kind: string) => string | null | undefined,
): T & { aiTranslated?: boolean } {
  const language = primaryLanguage(viewerLocale);
  if (language === '' || language === 'en') return theme;
  if (theme.is_catchall) {
    const label = catchallLabel?.(theme.kind);
    return label ? { ...theme, label } : theme;
  }
  const localized = readLocalized(theme.localized);
  if (!localized || primaryLanguage(localized.locale) !== language) return theme;
  return {
    ...theme,
    label: localized.label,
    summary: theme.summary === null ? null : (localized.summary ?? theme.summary),
    aiTranslated: true,
  };
}

/** True when `applyLocalizedTheme` swapped in an AI translation. */
export function isAiTranslatedTheme(theme: object | null | undefined): boolean {
  return (theme as { aiTranslated?: unknown } | null | undefined)?.aiTranslated === true;
}

/**
 * A feed chip's label in the viewer's language: the route's `localized.label` when
 * its locale matches the viewer, else the stored label.
 */
export function localizedChipLabel(
  chip: { label: string; localized?: unknown },
  viewerLocale: string | null | undefined,
): string {
  const language = primaryLanguage(viewerLocale);
  if (language === '' || language === 'en') return chip.label;
  const localized = chip.localized as { locale?: unknown; label?: unknown } | null | undefined;
  if (
    !localized ||
    typeof localized.locale !== 'string' ||
    primaryLanguage(localized.locale) !== language ||
    typeof localized.label !== 'string' ||
    localized.label.trim() === ''
  ) {
    return chip.label;
  }
  return localized.label;
}

/** The theme fields the landscape merge reads (route `LandscapeTheme` + `localized`). */
export interface LocalizableLandscapeTheme {
  label: string;
  summary: string | null;
  localized?: unknown;
}

/** A profile voice as far as the landscape merge is concerned. */
export interface LocalizableLandscapeVoice {
  themesByKind: { [kind: string]: LocalizableLandscapeTheme[] };
}

/** What `applyLocalizedLandscape` adds to a swapped theme. */
export interface LandscapeThemeTranslationFlags {
  /** True when `label`/`summary` are an AI translation. */
  aiTranslated?: boolean;
  /** The stored English label — a stable React key across a language switch. */
  englishLabel?: string;
}

/**
 * The competitive landscape as the viewer should see it (Brand Identity report
 * chapter, Brand Book, headless PDF). For every theme whose route-attached
 * `localized` matches the viewer's language, `label`/`summary` are swapped and the
 * theme is flagged `aiTranslated` (with `englishLabel` kept for keys); the landscape
 * gets `aiTranslated: true` when any theme was swapped. English / no usable
 * translation → the SAME object. Landscape themes are never catch-alls (the builder
 * excludes them), so there is no catalog-label branch here.
 */
export function applyLocalizedLandscape<
  L extends { self: LocalizableLandscapeVoice; competitors: LocalizableLandscapeVoice[] },
>(landscape: L, viewerLocale: string | null | undefined): L & { aiTranslated?: boolean } {
  const language = primaryLanguage(viewerLocale);
  if (language === '' || language === 'en') return landscape;
  let swapped = false;
  const mergeVoice = <V extends LocalizableLandscapeVoice>(voice: V): V => {
    const themesByKind: { [kind: string]: LocalizableLandscapeTheme[] } = {};
    for (const [kind, themes] of Object.entries(voice.themesByKind)) {
      themesByKind[kind] = (themes ?? []).map((theme) => {
        const localized = readLocalized(theme.localized);
        if (!localized || primaryLanguage(localized.locale) !== language) return theme;
        swapped = true;
        const merged: LocalizableLandscapeTheme & LandscapeThemeTranslationFlags = {
          ...theme,
          label: localized.label,
          summary: theme.summary === null ? null : (localized.summary ?? theme.summary),
          aiTranslated: true,
          englishLabel: theme.label,
        };
        return merged;
      });
    }
    return { ...voice, themesByKind } as V;
  };
  const self = mergeVoice(landscape.self);
  const competitors = landscape.competitors.map(mergeVoice);
  if (!swapped) return landscape;
  return { ...landscape, self, competitors, aiTranslated: true };
}

/** True when `applyLocalizedLandscape` swapped in at least one AI translation. */
export function isAiTranslatedLandscape(landscape: object | null | undefined): boolean {
  return (landscape as { aiTranslated?: unknown } | null | undefined)?.aiTranslated === true;
}

/** A landscape theme's stable list key: the English label, whatever language is shown. */
export function landscapeThemeKey(theme: { label: string; englishLabel?: unknown }): string {
  return typeof theme.englishLabel === 'string' && theme.englishLabel !== '' ? theme.englishLabel : theme.label;
}
