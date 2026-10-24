/**
 * Identity claim verification + candidate building — PURE. The integrity
 * rule (validateVerbatimQuotes clone, per-page haystacks): a sourced claim
 * survives ONLY when its source_sentence is an exact substring (whitespace-
 * normalized, case-insensitive) of the named page — or of ANY crawled page
 * when the model mislabeled the url. Unverifiable claims are DROPPED
 * entirely (integrity over recall; the founder can add them manually as
 * user_stated). The voice card is DERIVED by design and carries no source
 * sentence — it is exempt and lands at lower confidence.
 */
import { slugifyLabel } from '../fact-key';
import type { BrandSection, CandidateFact, EvidenceRef } from '../types';
import type { CrawledPage } from './pack';
import type { IdentityClaim, IdentityResponse } from './prompt';

const SOURCED_CONFIDENCE = 0.8;
const DERIVED_CONFIDENCE = 0.6;
/** Sentences shorter than this verify too easily to prove anything. */
const MIN_SENTENCE_CHARS = 12;

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface VerifiedIdentity {
  candidates: CandidateFact[];
  droppedCount: number;
}

export function buildIdentityCandidates(
  response: IdentityResponse,
  pages: CrawledPage[],
): VerifiedIdentity {
  const haystackByUrl = new Map(
    pages.map((page) => [page.url, normalize(page.text)]),
  );
  let droppedCount = 0;

  const verifyClaim = (claim: IdentityClaim): EvidenceRef | null => {
    const sentence = claim.source_sentence?.trim();
    if (!sentence || sentence.length < MIN_SENTENCE_CHARS) return null;
    const needle = normalize(sentence);
    const named = claim.source_url
      ? haystackByUrl.get(claim.source_url)
      : undefined;
    const matchedUrl = named?.includes(needle)
      ? claim.source_url!
      : (pages.find((page) => haystackByUrl.get(page.url)?.includes(needle))
          ?.url ?? null);
    if (!matchedUrl) return null;
    return {
      type: 'crawl_page',
      url: matchedUrl,
      sourceSentence: sentence,
    };
  };

  const candidates: CandidateFact[] = [];
  const pushSourced = (
    section: BrandSection,
    claims: IdentityClaim[],
    singletonKey?: string,
  ) => {
    for (const claim of claims) {
      const evidence = verifyClaim(claim);
      if (!evidence) {
        droppedCount++;
        continue;
      }
      candidates.push({
        section,
        factKey: singletonKey ?? slugifyLabel(claim.statement),
        statement: claim.statement.trim(),
        details: {},
        confidence: SOURCED_CONFIDENCE,
        source: 'identity_extraction',
        evidence: [evidence],
        metrics: {},
      });
    }
  };

  if (response.positioning) {
    pushSourced('positioning', [response.positioning], 'core');
  }
  pushSourced('value_prop', response.value_props);
  pushSourced('usp', response.usps);
  pushSourced('proof_point', response.proof_points);
  pushSourced('compliance', response.compliance_notes);

  if (response.voice) {
    candidates.push({
      section: 'voice',
      factKey: 'core',
      statement: response.voice.statement.trim(),
      details: {
        traits: response.voice.traits,
        toneDo: response.voice.tone_do,
        toneDont: response.voice.tone_dont,
      },
      confidence: DERIVED_CONFIDENCE,
      source: 'identity_extraction',
      // Derived — provenance is the whole crawled page set.
      evidence: pages.map((page) => ({
        type: 'crawl_page' as const,
        url: page.url,
      })),
      metrics: {},
    });
  }

  // In-batch key dedupe (two near-identical value props slugging alike keep
  // the first — the model repeating itself is not two facts).
  const seen = new Set<string>();
  const deduped = candidates.filter((candidate) => {
    const key = `${candidate.section}:${candidate.factKey}`;
    if (seen.has(key)) {
      droppedCount++;
      return false;
    }
    seen.add(key);
    return true;
  });

  return { candidates: deduped, droppedCount };
}
