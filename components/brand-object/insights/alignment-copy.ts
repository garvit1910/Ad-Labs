'use client';

/**
 * Chapter 05 copy in the user's language. `lib/brand-object/alignment.ts`
 * writes every node note/detail and suggestion as English text (read as-is by
 * English, the Brand Book and any non-UI consumer) AND as a structured
 * `{ code, … }` twin; other locales render the twin through the catalog.
 * Node and example labels are claim/theme/angle text — data, never translated.
 */
import { useCallback } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { DEFAULT_LOCALE, toIntlTag } from '@/i18n/config';
import type {
  AlignmentDetailCopy,
  AlignmentNode,
  AlignmentNoteCopy,
  AlignmentSuggestion,
  AlignmentSuggestionCopy,
} from '@/lib/brand-object/alignment';
import { useSectionLabel } from './report-copy';

const NOTE_KEYS = {
  customers_say_it_back: 'customersSayItBack',
  matches_winning_pattern: 'matchesWinningPattern',
  customers_push_back: 'customersPushBack',
  nothing_echoes: 'nothingEchoes',
  claim_answers: 'claimAnswers',
  you_claim_this: 'youClaimThis',
  no_claim_answers: 'noClaimAnswers',
  beyond_claims: 'beyondClaims',
  no_labeled_ads: 'noLabeledAds',
  claim_never_run: 'claimNeverRun',
  ads_never_argue: 'adsNeverArgue',
  winning_angle_you_run: 'winningAngleYouRun',
  not_top_pattern: 'notTopPattern',
} as const satisfies Record<
  Exclude<AlignmentNoteCopy['code'], 'argue_in_ads'>,
  string
>;

const SUGGESTION_KEYS = {
  run_winning_angles: 'runWinningAngles',
  ship_claimed_angles: 'shipClaimedAngles',
  answer_objections: 'answerObjections',
  reconcile_contested_claims: 'reconcileContestedClaims',
  lean_into_strengths: 'leanIntoStrengths',
} as const satisfies Record<AlignmentSuggestionCopy['code'], string>;

export function useAlignmentCopy() {
  const locale = useLocale();
  const tNote = useTranslations('BrandReport.alignment.notes');
  const tDetail = useTranslations('BrandReport.alignment.details');
  const tSuggestion = useTranslations('BrandReport.alignment.suggestions');
  const sectionLabel = useSectionLabel();
  const vocKindSingular = useTranslations('BrandReport.sections');
  const english = locale === DEFAULT_LOCALE;

  const noteText = useCallback(
    (copy: AlignmentNoteCopy) =>
      copy.code === 'argue_in_ads'
        ? tNote('argueIn', { count: copy.count })
        : tNote(NOTE_KEYS[copy.code]),
    [tNote],
  );

  const detailText = useCallback(
    (copy: AlignmentDetailCopy) => {
      switch (copy.code) {
        case 'claim_section':
          return sectionLabel(copy.section);
        case 'voice_kind': {
          const kind =
            copy.section === 'voc_pain'
              ? vocKindSingular('vocPain')
              : copy.section === 'voc_desire'
                ? vocKindSingular('vocDesire')
                : copy.section === 'voc_objection'
                  ? vocKindSingular('vocObjection')
                  : vocKindSingular('vocPraise');
          return tDetail('voiceKind', { kind, count: copy.mentions });
        }
        case 'market_proof':
          return tDetail('marketProof', { proof: copy.proofPct });
        case 'market_proof_own':
          return tDetail('marketProofOwn', {
            proof: copy.proofPct,
            own: copy.ownPct,
          });
        case 'own_ads':
          return tDetail('ownAds', { count: copy.ads, own: copy.ownPct });
      }
    },
    [sectionLabel, tDetail, vocKindSingular],
  );

  const list = useCallback(
    (labels: string[]) =>
      new Intl.ListFormat(toIntlTag(locale), {
        style: 'long',
        type: 'conjunction',
      }).format(labels),
    [locale],
  );

  return {
    note: (node: AlignmentNode) => (english ? node.note : noteText(node.noteCopy)),
    detail: (node: AlignmentNode) =>
      english || !node.detailCopy ? node.detail : detailText(node.detailCopy),
    suggestion: (suggestion: AlignmentSuggestion) => {
      if (english) return suggestion.text;
      // Not every template pluralizes, so the values go in as one object.
      const values = {
        count: suggestion.copy.count,
        examples: list(suggestion.copy.examples),
      };
      return tSuggestion(SUGGESTION_KEYS[suggestion.copy.code], values);
    },
  };
}
