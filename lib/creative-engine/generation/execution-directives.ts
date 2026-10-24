/**
 * Execution-directive vocabulary (2026-08) — PURE. Maps winning-market
 * execution label values (market_prior facts over the visual fingerprint
 * dims) to short prompt cues describing HOW winning ads in the market are
 * staged/shot. The cues LAYER ON TOP of the renderer's fixed anti-slop
 * templates as run-state variation text — they never replace or weaken the
 * quality/constraint segments, which always render last.
 *
 * Separate from producibility.ts on purpose: that table's contract is
 * producibility STATUS per format; this is a directive vocabulary over the
 * label-taxonomy execution enums, with its own exhaustiveness pins (a new
 * enum member fails the Record type until a cue — possibly null — is
 * chosen). `null` = this value must produce NO directive (clean-image
 * doctrine: screen_capture/meme_style/digital imply fabricated UI or
 * overlaid text).
 */
import type {
  AdFormat,
  FingerprintSetting,
  Tone,
  VisualStyle,
} from '@/services/ad-library/label-taxonomy';

/** Fixed prefix — the "adaptable inspiration, not a spec" framing. */
export const EXECUTION_CUE_PREFIX =
  'Execution cues from winning ads in this market — adapt them naturally to this product, with creative freedom: ';

/**
 * Prefix for the sanitized winning-ad staging notes (PR2). Load-bearing
 * wording: the notes are loose reference, never a look to copy — the
 * product-fidelity and no-added-text constraints still render after (and
 * override) anything in the notes.
 */
export const EXECUTION_NOTES_PREFIX =
  "Staging inspiration from a winning ad in this market — loose reference only, reinterpret freely for THIS product, never copy another brand's look: ";

export const STYLE_EXECUTION_CUES: Record<VisualStyle, string | null> = {
  lo_fi_ugc:
    'a candid, phone-shot feel — natural light, imperfect framing, zero studio polish',
  polished_studio:
    'a controlled studio treatment — clean backdrop, deliberate lighting',
  designed_graphic:
    'a composed, design-led arrangement with strong color blocking (still no added text or graphics)',
  screen_capture: null,
  cinematic: 'filmic color grading and composition, shallow depth of field',
  meme_style: null,
  other: null,
};

export const SETTING_EXECUTION_CUES: Record<FingerprintSetting, string | null> =
  {
    home: 'staged in a real, lived-in home setting',
    studio: 'staged on a clean controlled backdrop',
    outdoor: 'staged outdoors in natural surroundings',
    digital: null,
    other: null,
  };

export const TONE_EXECUTION_CUES: Record<Tone, string | null> = {
  humorous: 'a light, playful mood',
  aspirational: 'an elevated, aspirational mood',
  educational: 'a clear, informative mood',
  fear_urgency: 'a bold, high-contrast mood with visual urgency',
  heartfelt: 'a warm, heartfelt mood',
  plain_promotional: 'a straightforward, product-first mood',
  other: null,
};

export const PEOPLE_EXECUTION_CUES: Record<'true' | 'false', string> = {
  true: 'include a real person naturally using the product',
  false: 'keep the product the sole subject, without people',
};

/** Top-ranked execution values from the market signals (raw label tokens). */
export interface ExecutionSignalValues {
  style?: string;
  setting?: string;
  tone?: string;
  peoplePresent?: string;
}

type PeopleValue = keyof typeof PEOPLE_EXECUTION_CUES;

/** The cue values one group's format EXCLUDES — any omitted axis allows all. */
export interface FormatCueExclusions {
  style?: readonly VisualStyle[];
  setting?: readonly FingerprintSetting[];
  people?: readonly PeopleValue[];
}

/**
 * Format × cue compatibility (2026-09-22). The market cues are composed PER
 * GROUP, filtered to what that group's format scene can honour — a market-wide
 * directive stamped on every group overrode a product_only_static scene with
 * "include a real person" and the candidate rendered a person in a kitchen.
 * The format's scene directive (producibility.ts) is the contract; a cue that
 * contradicts it is dropped, never negotiated. Tone cues are mood only and
 * compatible with every format. Rationale per format:
 *
 *   product_only_static — seamless studio hero: no lo-fi phone feel, no
 *     home/outdoor staging, no person (the no-people cue agrees and stays).
 *   studio — editorial studio set: no lo-fi feel, no home/outdoor staging,
 *     no person (no-people agrees and stays).
 *   lifestyle_static — real in-use moment in natural light: no studio
 *     backdrop setting, no polished_studio ("clean backdrop, deliberate
 *     lighting") or designed_graphic (design-led arrangement) style, and no
 *     "without people" cue (the scene IS a customer using it).
 *   ugc — candid lo-fi phone still: no polished_studio / designed_graphic /
 *     cinematic polish, no studio setting, no "without people" (it is held
 *     or in use).
 *   unboxing — overhead flat-lay of the just-opened package at its
 *     delivery: no studio or outdoor setting, and no "include a real person
 *     using the product" (it would break the overhead flat-lay).
 *
 * Formats without an entry are not_producible and never become groups; a
 * producible format without one is a test failure (exhaustiveness pin).
 */
export const FORMAT_CUE_EXCLUSIONS: Partial<Record<AdFormat, FormatCueExclusions>> = {
  product_only_static: {
    style: ['lo_fi_ugc'],
    setting: ['home', 'outdoor'],
    people: ['true'],
  },
  studio: {
    style: ['lo_fi_ugc'],
    setting: ['home', 'outdoor'],
    people: ['true'],
  },
  lifestyle_static: {
    style: ['polished_studio', 'designed_graphic'],
    setting: ['studio'],
    people: ['false'],
  },
  ugc: {
    style: ['polished_studio', 'designed_graphic', 'cinematic'],
    setting: ['studio'],
    people: ['false'],
  },
  unboxing: {
    setting: ['studio', 'outdoor'],
    people: ['true'],
  },
};

/**
 * True when the format's scene is people-free — derived from the SAME
 * exclusion table the cues use (one source of truth), so `buildGroup` can
 * swap a person-implying hook scene for its still-life variant.
 */
export function formatExcludesPeople(format: AdFormat): boolean {
  return FORMAT_CUE_EXCLUSIONS[format]?.people?.includes('true') ?? false;
}

/**
 * STYLE × SETTING pairs that contradict each other regardless of format — the
 * SETTING cue drops (style is the stronger whole-image treatment). Applied
 * after the format filter, so it only fires when both cues survived it.
 * lo_fi_ugc + studio: "zero studio polish" beside "a clean controlled
 * backdrop" was the self-contradicting prod directive (brief 007520cf).
 * polished_studio + home is deliberately NOT here — a controlled treatment in
 * a lived-in home is a coherent shot.
 */
export const STYLE_SETTING_CONFLICTS: ReadonlyArray<
  readonly [VisualStyle, FingerprintSetting]
> = [['lo_fi_ugc', 'studio']];

const EXECUTION_DIRECTIVE_MAX_CHARS = 350;

/**
 * Compose the execution directive for ONE group: non-null cues joined in the
 * fixed order style → setting → people → tone under EXECUTION_CUE_PREFIX.
 * With a `format`, cues that format's scene cannot honour are dropped first
 * (FORMAT_CUE_EXCLUSIONS); then a contradictory style × setting pair drops its
 * setting (STYLE_SETTING_CONFLICTS). Unknown or cue-less values contribute
 * nothing; zero cues → undefined (the group carries no directive). Deterministic,
 * capped: trailing cues drop before the prefix ever truncates mid-sentence.
 */
export function composeExecutionDirective(
  top: ExecutionSignalValues,
  format?: AdFormat,
): string | undefined {
  const exclusions: FormatCueExclusions =
    (format ? FORMAT_CUE_EXCLUSIONS[format] : undefined) ?? {};

  let style: VisualStyle | undefined;
  if (top.style && top.style in STYLE_EXECUTION_CUES) {
    const value = top.style as VisualStyle;
    if (STYLE_EXECUTION_CUES[value] && !exclusions.style?.includes(value)) {
      style = value;
    }
  }
  let setting: FingerprintSetting | undefined;
  if (top.setting && top.setting in SETTING_EXECUTION_CUES) {
    const value = top.setting as FingerprintSetting;
    if (SETTING_EXECUTION_CUES[value] && !exclusions.setting?.includes(value)) {
      setting = value;
    }
  }
  if (
    style &&
    setting &&
    STYLE_SETTING_CONFLICTS.some(
      ([conflictStyle, conflictSetting]) =>
        conflictStyle === style && conflictSetting === setting,
    )
  ) {
    setting = undefined;
  }

  const cues: string[] = [];
  if (style) cues.push(STYLE_EXECUTION_CUES[style] as string);
  if (setting) cues.push(SETTING_EXECUTION_CUES[setting] as string);
  if (
    top.peoplePresent &&
    top.peoplePresent in PEOPLE_EXECUTION_CUES &&
    !exclusions.people?.includes(top.peoplePresent as PeopleValue)
  ) {
    cues.push(PEOPLE_EXECUTION_CUES[top.peoplePresent as PeopleValue]);
  }
  if (top.tone && top.tone in TONE_EXECUTION_CUES) {
    const cue = TONE_EXECUTION_CUES[top.tone as Tone];
    if (cue) cues.push(cue);
  }
  while (
    cues.length > 0 &&
    EXECUTION_CUE_PREFIX.length + cues.join('; ').length + 1 >
      EXECUTION_DIRECTIVE_MAX_CHARS
  ) {
    cues.pop();
  }
  if (cues.length === 0) return undefined;
  return `${EXECUTION_CUE_PREFIX}${cues.join('; ')}.`;
}
