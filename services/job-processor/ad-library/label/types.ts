import type { AdFingerprint } from '@/services/ad-library/label-taxonomy';

export interface AdToLabel {
  id: string;
  competitor_id: string | null;
  creative_bodies: string[] | null;
  creative_link_titles: string[] | null;
  media_type: string | null;
  page_name: string | null;
  media_urls: string[] | null;
  video_urls: string[] | null;
  // Cross-org identity: the same (platform, external_ad_id) tracked by two orgs
  // is the SAME public creative, so a sibling org's label can be copied. Loaded
  // by the batch query in `process`; optional so callers that build an
  // AdToLabel for the LLM path alone (evals, fallbacks) need not supply them —
  // the copy step simply skips ads with no external id.
  platform?: string | null;
  external_ad_id?: string | null;
}

/**
 * A sibling org's `library_ads` row (a different org tracking the same public
 * ad). Only the identity + competitor link are read; the label content comes
 * from the joined `ad_labels` row.
 */
export interface SiblingLibraryAd {
  id: string;
  organization_id: string;
  platform: string | null;
  external_ad_id: string | null;
  competitor_id: string | null;
}

export interface LabelRow {
  organization_id: string;
  library_ad_id: string;
  hook_archetype: string;
  angle: string;
  angle_universal: string;
  persona: string;
  persona_universal: string;
  funnel_stage: string;
  format: string;
  style: string | null;
  aspect_ratio: string | null;
  fingerprint: AdFingerprint | null;
  offer_type: string | null;
  hook_text: string;
  summary: string;
  confidence: number;
  model: string;
  labeled_at: string;
  tags: { taxonomyVersion: number };
}
