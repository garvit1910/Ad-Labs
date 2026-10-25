/*
 * How much of an ad the sim shows, shared by A4's live ads and A5's generated ones.
 * B's renderer (sim/src/render.ts) prints every post as
 * "<brand>: <headline> <primary_text> [Button: <cta>] [Image: <visual_description>]",
 * three posts per feed state, and throws on a state of 450 words or more. So the rows
 * carry what an Instagram feed shows before "… more" (about 125 characters of primary
 * text), and a glance at the image, not the art brief.
 */

export const FEED_HEADLINE_MAX_WORDS = 10;
export const FEED_PRIMARY_MAX_WORDS = 25;
export const FEED_IMAGE_MAX_WORDS = 12;

/** Whitespace and line breaks collapsed: a blank line would break the state's block layout. */
export const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

const wordCount = (text: string) => text.split(' ').filter(Boolean).length;

/**
 * The leading whole sentences that fit in `max` words; when even the first doesn't,
 * its first `max` words and an ellipsis, the way a feed truncates.
 */
export function clipWords(text: string, max: number): string {
  const all = flat(text);
  if (wordCount(all) <= max) return all;
  let out = '';
  for (const sentence of all.split(/(?<=[.!?])\s/)) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (wordCount(next) > max) break;
    out = next;
  }
  if (out) return out;
  return `${all.split(' ').slice(0, max).join(' ').replace(/[\s,;:—-]+$/u, '')}…`;
}

/**
 * The image line: the first sentence of a visual description, cut to `max` words at a
 * clause boundary when one leaves at least six words, else at the word.
 */
export function feedImage(text: string, max = FEED_IMAGE_MAX_WORDS): string {
  const sentence = flat(text).split(/(?<=[.!?])\s/)[0] ?? '';
  const words = sentence.split(' ').filter(Boolean);
  if (words.length <= max) return sentence;
  const head = words.slice(0, max).join(' ');
  const clauseEnd = Math.max(head.lastIndexOf(','), head.lastIndexOf(';'), head.lastIndexOf(' —'));
  const clause = clauseEnd > 0 ? head.slice(0, clauseEnd) : '';
  const cut = (wordCount(clause) >= 6 ? clause : head).replace(/[\s,;:—-]+$/u, '').split(' ');
  // A cut mid-phrase shouldn't end on "… during an" or "… with the".
  while (cut.length > 6 && DANGLING.has(cut[cut.length - 1].toLowerCase())) cut.pop();
  return `${cut.join(' ').replace(/[\s,;:—-]+$/u, '')}.`;
}

const DANGLING = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'while', 'during', 'as', 'its', 'their', 'into', 'over', 'under', 'near']);

export const feedHeadline = (text: string) => clipWords(text, FEED_HEADLINE_MAX_WORDS);
export const feedPrimary = (text: string) => clipWords(text, FEED_PRIMARY_MAX_WORDS);
