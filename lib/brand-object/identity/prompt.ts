/**
 * Identity-extraction response contract: strict json_schema (every property
 * required per the OpenAI strict rule — optionals are nullable-but-required)
 * + zod re-validation of the decoded payload (lib/brand-presence/llm.ts
 * pattern). The model tier defaults to the full model — identity extraction
 * is a judgment-quality call (relevance-gate precedent).
 */
import { z } from 'zod';
import { strictResponseFormat } from '@/lib/brand-presence/llm';
import { modelForRole } from '@/lib/llm/model-roles';

export function getBrandObjectIdentityModel(): string {
  return modelForRole('brand_object_identity');
}

const claimSchema = z.object({
  statement: z.string().min(1),
  source_sentence: z.string().nullable(),
  source_url: z.string().nullable(),
});
export type IdentityClaim = z.infer<typeof claimSchema>;

export const identityResponseSchema = z.object({
  positioning: claimSchema.nullable(),
  value_props: z.array(claimSchema),
  usps: z.array(claimSchema),
  proof_points: z.array(claimSchema),
  voice: z
    .object({
      statement: z.string().min(1),
      traits: z.array(z.string()),
      tone_do: z.array(z.string()),
      tone_dont: z.array(z.string()),
    })
    .nullable(),
  compliance_notes: z.array(claimSchema),
});
export type IdentityResponse = z.infer<typeof identityResponseSchema>;

const CLAIM_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  // OpenAI strict rule: every property listed in required.
  required: ['statement', 'source_sentence', 'source_url'],
  properties: {
    statement: { type: 'string' },
    source_sentence: { type: ['string', 'null'] },
    source_url: { type: ['string', 'null'] },
  },
} as const;

export const IDENTITY_RESPONSE_FORMAT = strictResponseFormat(
  'brand_identity_extraction',
  {
    type: 'object',
    additionalProperties: false,
    required: [
      'positioning',
      'value_props',
      'usps',
      'proof_points',
      'voice',
      'compliance_notes',
    ],
    properties: {
      positioning: { anyOf: [CLAIM_JSON_SCHEMA, { type: 'null' }] },
      value_props: { type: 'array', items: CLAIM_JSON_SCHEMA },
      usps: { type: 'array', items: CLAIM_JSON_SCHEMA },
      proof_points: { type: 'array', items: CLAIM_JSON_SCHEMA },
      voice: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['statement', 'traits', 'tone_do', 'tone_dont'],
            properties: {
              statement: { type: 'string' },
              traits: { type: 'array', items: { type: 'string' } },
              tone_do: { type: 'array', items: { type: 'string' } },
              tone_dont: { type: 'array', items: { type: 'string' } },
            },
          },
          { type: 'null' },
        ],
      },
      compliance_notes: { type: 'array', items: CLAIM_JSON_SCHEMA },
    },
  },
);
