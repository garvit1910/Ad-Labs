/**
 * Persona-synthesis response contract: strict json_schema + zod, plus the
 * PURE return gates — unknown fact ids are dropped, verbatims must be exact
 * (whitespace-normalized) copies of pack-supplied quotes, and a persona
 * surviving with no grounded pains AND no grounded desires dissolves.
 */
import { z } from 'zod';
import { strictResponseFormat } from '@/lib/brand-presence/llm';
import { slugifyLabel } from '../fact-key';
import { AWARENESS_STAGES, type CandidateFact } from '../types';
import type { PersonaPack } from './pack';
import { rankPersonaVerbatims } from './verbatim-rank';
import { modelForRole } from '@/lib/llm/model-roles';

export function getBrandObjectPersonaModel(): string {
  return modelForRole('brand_object_personas');
}

const factRefSchema = z.object({
  fact_id: z.string(),
  note: z.string(),
});

export const personasResponseSchema = z.object({
  personas: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().min(1),
        awareness_stage: z.enum(AWARENESS_STAGES),
        pains: z.array(factRefSchema),
        desires: z.array(factRefSchema),
        objections: z.array(factRefSchema),
        verbatims: z.array(z.string()),
      }),
    )
    .min(1)
    .max(6),
  // The unaware buyer cannot appear in a corpus of observed customer voice, so
  // this slot is a backward EXTRAPOLATION from the grounded facts — same
  // fact-ref gate, no awareness_stage field (the slot IS the stage). Optional
  // in zod for pre-projection callers; the strict JSON schema always sends it.
  unaware_projection: z
    .object({
      name: z.string().min(1),
      description: z.string().min(1),
      pains: z.array(factRefSchema),
      desires: z.array(factRefSchema),
      objections: z.array(factRefSchema),
      verbatims: z.array(z.string()),
    })
    .nullable()
    .optional(),
});
export type PersonasResponse = z.infer<typeof personasResponseSchema>;

const FACT_REF_JSON = {
  type: 'object',
  additionalProperties: false,
  required: ['fact_id', 'note'],
  properties: {
    fact_id: { type: 'string' },
    note: { type: 'string' },
  },
} as const;

export const PERSONAS_RESPONSE_FORMAT = strictResponseFormat(
  'brand_personas',
  {
    type: 'object',
    additionalProperties: false,
    required: ['personas', 'unaware_projection'],
    properties: {
      personas: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'name',
            'description',
            'awareness_stage',
            'pains',
            'desires',
            'objections',
            'verbatims',
          ],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            awareness_stage: { type: 'string', enum: [...AWARENESS_STAGES] },
            pains: { type: 'array', items: FACT_REF_JSON },
            desires: { type: 'array', items: FACT_REF_JSON },
            objections: { type: 'array', items: FACT_REF_JSON },
            verbatims: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      unaware_projection: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: [
          'name',
          'description',
          'pains',
          'desires',
          'objections',
          'verbatims',
        ],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          pains: { type: 'array', items: FACT_REF_JSON },
          desires: { type: 'array', items: FACT_REF_JSON },
          objections: { type: 'array', items: FACT_REF_JSON },
          verbatims: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
);

const PERSONA_CONFIDENCE = 0.65;
/**
 * The unaware projection is an inference over grounded facts, not an observed
 * buyer — it must never outrank a persona someone's actual words produced.
 */
const EXTRAPOLATED_CONFIDENCE = 0.5;
/**
 * Stable fact key for the ONE projection slot. Persona keys come from the
 * LLM-authored name, which drifts across runs; a fixed key means re-synthesis
 * supersedes the previous projection instead of accreting a parallel one.
 */
export const UNAWARE_PROJECTION_FACT_KEY = 'unaware-projection';

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface ValidatedPersonas {
  candidates: CandidateFact[];
  droppedRefs: number;
  droppedVerbatims: number;
}

export function validatePersonas(
  response: PersonasResponse,
  pack: PersonaPack,
): ValidatedPersonas {
  const allowed = new Set(pack.allowedVerbatims.map(normalize));
  let droppedRefs = 0;
  let droppedVerbatims = 0;

  const gate = (refs: Array<{ fact_id: string; note: string }>) =>
    refs.filter((ref) => {
      const known = pack.factIds.has(ref.fact_id);
      if (!known) droppedRefs++;
      return known;
    });
  const gateVerbatims = (quotes: string[]) =>
    // Gate first (exact pack copies only), then order best-first so the stored
    // array leads with the line that actually portrays the buyer — the display
    // card and the retrieval chunk both read from the front.
    rankPersonaVerbatims(
      quotes.filter((quote) => {
        const ok = allowed.has(normalize(quote));
        if (!ok) droppedVerbatims++;
        return ok;
      }),
    );

  const toCandidate = (
    persona: {
      name: string;
      description: string;
      pains: Array<{ fact_id: string; note: string }>;
      desires: Array<{ fact_id: string; note: string }>;
      objections: Array<{ fact_id: string; note: string }>;
      verbatims: string[];
    },
    stage: {
      awarenessStage: string;
      factKey: string;
      confidence: number;
      extrapolated: boolean;
    },
  ): CandidateFact | null => {
    const pains = gate(persona.pains);
    const desires = gate(persona.desires);
    const objections = gate(persona.objections);
    const verbatims = gateVerbatims(persona.verbatims);
    // A persona with no grounded pains AND no grounded desires is fiction —
    // and that goes double for the projection, whose whole warrant is that it
    // extrapolates from real facts.
    if (pains.length === 0 && desires.length === 0) return null;

    const referenced = [...pains, ...desires, ...objections].map(
      (ref) => ref.fact_id,
    );
    return {
      section: 'persona',
      factKey: stage.factKey,
      statement: `${persona.name}: ${persona.description}`,
      details: {
        name: persona.name,
        description: persona.description,
        awarenessStage: stage.awarenessStage,
        extrapolated: stage.extrapolated,
        pains,
        desires,
        objections,
        verbatims,
      },
      confidence: stage.confidence,
      source: 'persona_synthesis',
      evidence: [
        ...[...new Set(referenced)].map((factId) => ({
          type: 'fact' as const,
          id: factId,
        })),
        ...verbatims.map((quote) => ({ type: 'fact' as const, quote })),
      ],
      metrics: {},
    };
  };

  const candidates: CandidateFact[] = [];
  for (const persona of response.personas) {
    const candidate = toCandidate(persona, {
      awarenessStage: persona.awareness_stage,
      factKey: slugifyLabel(persona.name),
      confidence: PERSONA_CONFIDENCE,
      extrapolated: false,
    });
    if (candidate) candidates.push(candidate);
  }
  if (response.unaware_projection) {
    const candidate = toCandidate(response.unaware_projection, {
      awarenessStage: 'unaware',
      factKey: UNAWARE_PROJECTION_FACT_KEY,
      confidence: EXTRAPOLATED_CONFIDENCE,
      extrapolated: true,
    });
    if (candidate) candidates.push(candidate);
  }

  return { candidates, droppedRefs, droppedVerbatims };
}

/**
 * Split validated candidates for the processor's cap/min gates: the projection
 * must never evict a grounded persona from the `personas.max` cap, and it must
 * never count toward the `personas.min` survival gate (a run that produced
 * only the extrapolation grounded nothing and should retry).
 */
export function splitPersonaCandidates(
  candidates: CandidateFact[],
  maxGrounded: number,
): { grounded: CandidateFact[]; capped: CandidateFact[] } {
  const grounded = candidates.filter(
    (candidate) => candidate.details.extrapolated !== true,
  );
  const projections = candidates.filter(
    (candidate) => candidate.details.extrapolated === true,
  );
  return {
    grounded,
    capped: [...grounded.slice(0, maxGrounded), ...projections],
  };
}
