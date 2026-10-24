/**
 * Pure evidence parsing for Chapter 02 — no React, no IO, so the whole surface
 * is unit-testable. Extracted from `BrandNarrativePanel` when the figure band
 * (`narrative-figures.ts`) needed the same sub-item split without importing a
 * client component.
 */

export type EvidenceItem = {
  /** Humanized leading label, or null when the item carries no subheading. */
  subheading: string | null;
  /** The rest of the item, byte-identical to what the synthesis stored. */
  body: string;
};

const ACRONYMS = new Set(['USP', 'CTA', 'ROAS', 'UGC', 'AI']);

/**
 * Acronyms a reader should never have to decode. The synthesis writes the
 * stream label as "VOC"; the report spells it out ("VOC praise" → "Voice of
 * customer praise"). Expansion runs before the acronym pass, so an expanded
 * term must NOT also be listed in ACRONYMS.
 */
const EXPANSIONS: Record<string, string> = { VOC: 'voice of customer' };

// A colon-led label ("identity value_prop:", "verbatim:", "Compliance says:",
// "Personas also surface fit friction:"). The class excludes `"` so a colon
// inside a quoted verbatim can never be read as a label boundary, and the
// length cap keeps a full sentence from matching. The cap must stay in sync
// with the one in NEXT_SUBHEADING below.
// `;` is excluded alongside `"` because a label never spans a sub-item
// separator — without it, "…bars" with 28 mentions; verbatim:" reads the whole
// run as a label and strands "with 28 mentions" as its own item.
const COLON_SUBHEADING = /^([A-Za-z][^";:\n]{0,39}):\s+([\s\S]+)$/;
// A stream + facet label with no colon ("VOC praise", "market Angle"). The
// facet must be a KNOWN one: older rows narrate in prose ("Identity claims
// include …", "Identity proof points span …"), and an open facet pattern turns
// the first two words of such a sentence into a bogus bold label.
const STREAM_FACET =
  'positioning|value_prop|usp|proof_point|voice|pain|desire|objection|praise|angle|hook|format|offer|prior|intel';
// "voice of customer" is accepted alongside "VOC" because the prompt asks the
// model to spell the acronym out — a spelled-out label must still parse.
const STREAM =
  'identity|voice of customer|voc|market|personas?|compliance';
const STREAM_SUBHEADING = new RegExp(
  `^(${STREAM})\\s+(${STREAM_FACET})\\b\\s+([\\s\\S]+)$`,
  'i',
);
// Lookahead for "does the NEXT sub-item start here?" — either label shape.
const NEXT_SUBHEADING = new RegExp(
  `^\\s+(?:(?:${STREAM})\\s+(?:${STREAM_FACET})\\b\\s|[A-Za-z][^";:\\n]{0,39}:\\s)`,
  'i',
);

function humanizeSubheading(raw: string): string {
  return raw
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word, index) => {
      const upper = word.toUpperCase();
      const expanded = EXPANSIONS[upper];
      if (!expanded && (ACRONYMS.has(upper) || /^[A-Z0-9]{2,}$/.test(word))) {
        return upper;
      }
      const lower = expanded ?? word.toLowerCase();
      return index === 0 ? `${lower.charAt(0).toUpperCase()}${lower.slice(1)}` : lower;
    })
    .join(' ');
}

/**
 * A finding's `evidence` packs several cited sub-items into one string,
 * separated by "; " (newlines in older rows, and — in live tension rows — a
 * bare sentence period), each led by a subheading in one of two shapes: colon
 * form ("identity value_prop:", "verbatim:") or stream+facet form with no
 * colon ("VOC praise", "market Angle").
 *
 * Two constraints drive the parsing: (1) quoted customer verbatims and pack
 * numbers must render EXACTLY as stored, so only the subheading is ever
 * rewritten and the split ignores separators inside quotes; (2) evidence is
 * free LLM text, so an unsplittable/unlabelled string must still come back as
 * one plain item.
 */
export function parseEvidenceItems(evidence: string): EvidenceItem[] {
  const segments: string[] = [];
  let current = '';
  let inQuote = false;

  for (let index = 0; index < evidence.length; index += 1) {
    const char = evidence[index];
    if (char === '"' || char === '“' || char === '”') {
      const closing = inQuote;
      inQuote = !inQuote;
      current += char;
      // A closing quote ends the sub-item when the next one opens right after
      // it (the period that would otherwise mark the break sits INSIDE the
      // quote). The quote stays on the segment it closes.
      if (closing && NEXT_SUBHEADING.test(evidence.slice(index + 1))) {
        segments.push(current);
        current = '';
      }
      continue;
    }
    if (!inQuote) {
      if (
        char === '\n' ||
        (char === ';' && /\s/.test(evidence[index + 1] ?? ' '))
      ) {
        segments.push(current);
        current = '';
        continue;
      }
      // A period ends a sub-item ONLY when the next one opens with a
      // recognized subheading — a period followed by ordinary prose must never
      // fragment a sentence. The period stays attached to the segment it
      // closes so the stored text survives byte-identical.
      if (char === '.' && NEXT_SUBHEADING.test(evidence.slice(index + 1))) {
        segments.push(`${current}.`);
        current = '';
        continue;
      }
    }
    current += char;
  }
  segments.push(current);

  return segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const colon = COLON_SUBHEADING.exec(segment);
      if (colon) {
        return { subheading: humanizeSubheading(colon[1]), body: colon[2] };
      }
      const stream = STREAM_SUBHEADING.exec(segment);
      if (stream) {
        return {
          subheading: humanizeSubheading(`${stream[1]} ${stream[2]}`),
          body: stream[3],
        };
      }
      return { subheading: null, body: segment };
    });
}
