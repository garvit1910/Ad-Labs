/**
 * Copy renderer v2 — one pack in, one `{system, user}` prompt out for the
 * Phase-5 LLM copywriter (same message-pair seam as rsa-copy's
 * buildRsaCopyPrompt / getLLMProvider().complete).
 *
 * Section order is the locked contract: facts → voice → persona →
 * audience override → task → rules LAST (recency-weighted — the rules are
 * the non-negotiables the model reads immediately before writing).
 *
 * v2 (2026-08-04 quality rework): the angle is INTERNAL strategy the copy
 * must EXPRESS through a concrete fact-grounded claim or vivid specific
 * moment — v1's "use verbatim, do not rephrase" pasted strategy prose
 * straight into headlines ("Style Meets Value: Shop Smart Today!"). The
 * task section now carries execution guidance + the BANNED_AD_SPEAK list,
 * enforced deterministically by generation/brand-copy.ts's post-generation
 * guards. The verbatim requirement belongs to the genome attribution key,
 * never the copy text.
 *
 * v3 (2026-08-05): every rendered row string goes through
 * `collapseWhitespace` — fact statements and persona verbatims are
 * customer-review-derived, and a newline inside one could forge a `## `
 * section header (or a fake instruction line) in this prompt.
 */
import { type BrandContextPack, type SlotEntry } from '../types';
import { BANNED_AD_SPEAK } from '../../brand-check/banned-ad-speak';
import {
  assertRendererVersion,
  collapseWhitespace,
  noteList,
  optionalString,
  requireString,
} from './shared';

export interface CopyRender {
  system: string;
  user: string;
}

const SYSTEM_PROMPT = [
  'You are a senior direct-response copywriter. You write specific, concrete ad copy that could only be written for THIS brand.',
  'Ground every claim ONLY in the brand facts provided. If a specific number, ingredient, or attribute is not in the facts, write the line without it — NEVER invent statistics, quantities, ingredients, awards, or reviews.',
  'Express the strategic angle through a concrete, fact-grounded claim or a vivid specific moment — never restate the angle itself as copy, and never produce generic retail phrases.',
  'Match the brand voice exactly and speak directly to the target audience.',
  'The rules at the end of the brief are non-negotiable: before finalizing, check every line of copy against every rule.',
].join(' ');

/**
 * Generic ad-speak the copywriter must never produce. The ONE list lives in
 * the zero-import `brand-check/banned-ad-speak.ts` (shared with the
 * client-safe brand check); re-exported here so this renderer's public
 * surface and every existing import path are unchanged.
 */
export { BANNED_AD_SPEAK };

const EMPTY_VOICE_LINE =
  'None on file — write in clear, direct, plain language.';
const EMPTY_RULES_LINE =
  "None on file — apply the platform's standard ad policies.";

function factsSection(pack: BrandContextPack): string {
  const pinned = Boolean(pack.meta.spec.keyMessageRef);
  const lines = pack.slots.facts.map((entry, index) => {
    const section = optionalString(entry, 'section');
    const statement = collapseWhitespace(
      requireString(entry, 'statement', 'facts'),
    );
    const marker =
      pinned && index === 0 ? ' (KEY MESSAGE — lead with this)' : '';
    const label = section ? `[${collapseWhitespace(section)}] ` : '';
    return `${index + 1}. ${label}${statement}${marker}`;
  });
  return ['## Brand facts', ...lines].join('\n');
}

function voiceSection(pack: BrandContextPack): string {
  const lines =
    pack.slots.voice.length > 0
      ? pack.slots.voice.map(
          (entry) =>
            `- ${collapseWhitespace(requireString(entry, 'statement', 'voice'))}`,
        )
      : [EMPTY_VOICE_LINE];
  return ['## Brand voice', ...lines].join('\n');
}

function personaList(
  entry: SlotEntry,
  key: string,
  label: string,
  quote = false,
): string[] {
  const items = noteList(entry, key, 'persona').map(collapseWhitespace);
  if (items.length === 0) return [];
  return [
    `${label}:`,
    ...items.map((item) => (quote ? `- "${item}"` : `- ${item}`)),
  ];
}

function personaSection(pack: BrandContextPack): string {
  const persona = pack.slots.persona;
  const lines = [
    `Name: ${collapseWhitespace(requireString(persona, 'name', 'persona'))}`,
    `Description: ${collapseWhitespace(
      requireString(persona, 'description', 'persona'),
    )}`,
  ];
  const stage = optionalString(persona, 'awarenessStage');
  if (stage) lines.push(`Awareness stage: ${collapseWhitespace(stage)}`);
  lines.push(
    ...personaList(persona, 'pains', 'Pains'),
    ...personaList(persona, 'desires', 'Desires'),
    ...personaList(persona, 'objections', 'Objections'),
    ...personaList(persona, 'verbatims', 'Customer verbatims', true),
  );
  return ['## Persona', ...lines].join('\n');
}

function audienceOverrideSection(pack: BrandContextPack): string | null {
  const override = pack.meta.spec.overrides?.audience;
  if (!override) return null;
  return [
    '## Audience override',
    `Target THIS audience for the copy (it supersedes the persona description above; the persona still anchors tone and pains): ${override}`,
  ].join('\n');
}

function taskSection(pack: BrandContextPack): string {
  const { spec } = pack.meta;
  const lines = [
    `Platform: ${spec.platform}`,
    `Goal: ${spec.goal}`,
    `Strategic angle (INTERNAL strategy — express it through the copy, never quote or restate it): ${spec.angle}`,
  ];
  if (spec.product) lines.push(`Product focus: ${spec.product}`);
  lines.push(
    '',
    'How to execute the angle:',
    '- The headline must make ONE concrete claim or paint ONE specific moment that proves the angle, using details from the Brand facts section.',
    '- If the angle involves a measurable benefit and a fact states the number, use the number EXACTLY as the fact states it. If no fact states a number, write the line without any number — NEVER invent one.',
    '- If the angle is emotional (nostalgia, status, relief), the line itself must evoke that feeling through specifics — never announce it ("Experience nostalgia" is a failure).',
    `- BANNED — never write these or structurally similar empty retail phrases: ${BANNED_AD_SPEAK.map((phrase) => `"${phrase}"`).join(', ')}.`,
  );
  return ['## Task', ...lines].join('\n');
}

function rulesSection(pack: BrandContextPack): string {
  const lines =
    pack.slots.rules.length > 0
      ? pack.slots.rules.map(
          (entry, index) =>
            `${index + 1}. ${collapseWhitespace(
              requireString(entry, 'statement', 'rules'),
            )}`,
        )
      : [EMPTY_RULES_LINE];
  return ['## Rules (non-negotiable — verify every one)', ...lines].join('\n');
}

export function renderCopyPrompt(pack: BrandContextPack): CopyRender {
  assertRendererVersion(pack, 'copy');
  const sections = [
    factsSection(pack),
    voiceSection(pack),
    personaSection(pack),
    audienceOverrideSection(pack),
    taskSection(pack),
    rulesSection(pack),
  ].filter((section): section is string => section !== null);
  return { system: SYSTEM_PROMPT, user: sections.join('\n\n') };
}
