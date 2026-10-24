/**
 * Chapter 02's figure band — the deterministic pass that pulls the numbers the
 * narrative cites OUT of the prose so the chapter has something to land on
 * before the reading starts. No React, no IO, no LLM: every figure is lifted
 * verbatim from a finding the synthesis already wrote, and the caption is that
 * finding's own point, in full and unclipped. Nothing here sources,
 * reformats, or rewords a number — a figure that is not already written in a
 * strength/tension never appears in the band, and the story highlighter only
 * tints tokens that are already in the paragraph.
 */
import type { BrandSynthesis } from '@/lib/brand-object/synthesis/types';

import { parseEvidenceItems } from './narrative-evidence';

export type FigureTone = 'strength' | 'tension';

export interface NarrativeFigure {
  /** The figure exactly as the finding wrote it — never reformatted. */
  value: string;
  /** Match key so the band and the story agree that "1,280" ≡ "1280". */
  key: string;
  tone: FigureTone;
  /** The finding's point, verbatim — the tile shows it in full, never clipped. */
  caption: string;
  /** Provenance lifted from the evidence subheading ("Voice of customer praise"). */
  source: string | null;
}

/** Money, plain counts, decimals, percentages — the shapes a pack number takes. */
const FIGURE_PATTERN = /\$?\d[\d,]*(?:\.\d+)?%?/g;
/** A quoted span in evidence is a customer's words, not a pack number. */
const QUOTED_SPAN = /["“][^"“”]*["”]/g;
/** Tiles per band. Matches the four-across grid Chapter 04 already uses. */
export const FIGURE_BAND_CAP = 4;
/** Below this the band reads as an accident rather than a summary. */
export const FIGURE_BAND_MIN = 2;

/** "1,280" and "1280" are the same figure; "$38" and "62%" keep their unit. */
function figureKey(value: string): string {
  return value.replace(/,/g, '');
}

/**
 * A bare four-digit number in calendar range is a year, not a measurement.
 * Percentages and money keep their unit, so they are never mistaken for one.
 */
function isYear(value: string): boolean {
  if (value.includes('%') || value.includes('$')) return false;
  const digits = figureKey(value);
  return /^\d{4}$/.test(digits) && Number(digits) >= 1900 && Number(digits) <= 2099;
}

function matchFigures(text: string): string[] {
  return (text.match(FIGURE_PATTERN) ?? []).filter((value) => !isYear(value));
}

/**
 * Every figure the findings cite, strengths first, in the order the synthesis
 * wrote them. The figure comes from the finding's `point` when it has one —
 * the prompt makes the point quote pack numbers — and falls back to its
 * evidence with quoted verbatims stripped.
 */
export function narrativeFigures(synthesis: BrandSynthesis): NarrativeFigure[] {
  const findings: Array<{ tone: FigureTone; point: string; evidence: string }> = [
    ...synthesis.strengths.map((finding) => ({
      tone: 'strength' as const,
      point: finding.point,
      evidence: finding.evidence,
    })),
    ...synthesis.tensions.map((finding) => ({
      tone: 'tension' as const,
      point: finding.point,
      evidence: finding.evidence,
    })),
  ];

  const figures: NarrativeFigure[] = [];
  for (const finding of findings) {
    const fromPoint = matchFigures(finding.point)[0] ?? null;
    const items = parseEvidenceItems(finding.evidence ?? '');
    const value =
      fromPoint ??
      items
        .map((item) => matchFigures(item.body.replace(QUOTED_SPAN, ' '))[0])
        .find((found): found is string => found != null) ??
      null;
    if (value == null) continue;

    // Provenance is the subheading of the sub-item that carries the figure —
    // the exact stream the number came down from — else the first label.
    const carrier =
      items.find((item) =>
        matchFigures(item.body.replace(QUOTED_SPAN, ' ')).includes(value),
      ) ?? items[0];

    figures.push({
      value,
      key: figureKey(value),
      tone: finding.tone,
      caption: finding.point.trim(),
      source: carrier?.subheading ?? null,
    });
  }
  return figures;
}

/**
 * The displayed band. SELECTION interleaves strengths and tensions so a capped
 * band still shows both sides of the read; DISPLAY then reorders the survivors
 * strengths-first, so the row reads positives-then-tensions left to right
 * rather than alternating green/red. Deduped by figure, capped at
 * `FIGURE_BAND_CAP`.
 */
export function figureBand(
  figures: NarrativeFigure[],
  cap = FIGURE_BAND_CAP,
): NarrativeFigure[] {
  const strengths = figures.filter((figure) => figure.tone === 'strength');
  const tensions = figures.filter((figure) => figure.tone === 'tension');
  const interleaved: NarrativeFigure[] = [];
  for (let index = 0; index < Math.max(strengths.length, tensions.length); index += 1) {
    if (strengths[index]) interleaved.push(strengths[index]);
    if (tensions[index]) interleaved.push(tensions[index]);
  }

  const seen = new Set<string>();
  const band: NarrativeFigure[] = [];
  for (const figure of interleaved) {
    if (seen.has(figure.key)) continue;
    seen.add(figure.key);
    band.push(figure);
    if (band.length === cap) break;
  }
  return [
    ...band.filter((figure) => figure.tone === 'strength'),
    ...band.filter((figure) => figure.tone === 'tension'),
  ];
}

/**
 * Tone per figure key for the inline story highlight. A figure cited as both a
 * strength and a tension reads neutral — the page must not assert a direction
 * the findings disagree on. Built from ALL figures, not just the band, so the
 * story stays consistent when the band is capped.
 */
export function figureTones(
  figures: NarrativeFigure[],
): Map<string, FigureTone | 'neutral'> {
  const tones = new Map<string, FigureTone | 'neutral'>();
  for (const figure of figures) {
    const existing = tones.get(figure.key);
    if (existing == null) tones.set(figure.key, figure.tone);
    else if (existing !== figure.tone) tones.set(figure.key, 'neutral');
  }
  return tones;
}

export type StorySegment =
  | { kind: 'text'; text: string }
  | { kind: 'figure'; text: string; tone: FigureTone | 'neutral' };

/**
 * Split a narrative paragraph into plain text and figure tokens, preserving
 * every character — concatenating the segments returns the paragraph exactly.
 * Tone comes from the findings; a figure the findings never cite still
 * highlights, neutrally, because it is still a number the reader should see.
 */
export function splitStoryFigures(
  paragraph: string,
  tones: Map<string, FigureTone | 'neutral'>,
): StorySegment[] {
  const segments: StorySegment[] = [];
  let cursor = 0;
  // A fresh regex per call — `lastIndex` on a shared /g literal leaks state.
  const pattern = new RegExp(FIGURE_PATTERN.source, 'g');

  let match = pattern.exec(paragraph);
  while (match !== null) {
    const value = match[0];
    if (!isYear(value)) {
      if (match.index > cursor) {
        segments.push({ kind: 'text', text: paragraph.slice(cursor, match.index) });
      }
      segments.push({
        kind: 'figure',
        text: value,
        tone: tones.get(figureKey(value)) ?? 'neutral',
      });
      cursor = match.index + value.length;
    }
    match = pattern.exec(paragraph);
  }
  if (cursor < paragraph.length) {
    segments.push({ kind: 'text', text: paragraph.slice(cursor) });
  }
  return segments;
}
