import { z } from "zod";

// Row shapes for the SpacetimeDB tables in docs/PLAN.md "The contract". Field names match
// the contract exactly; .strict() rejects any extra field. Columns the contract marks
// "json" appear here parsed (objects/arrays); spacetime.ts (B4) stringifies them on write.

export const ANGLES = [
  "taste_indulgence",
  "health_nutrition",
  "convenience",
  "natural_clean",
  "craving",
  "dietary_fit",
  "price_value",
  "trust_safety",
] as const;

// HOOK_ARCHETYPES limited to the ones Adcero's copywriter can produce.
export const HOOKS_ALWAYS = [
  "problem_callout",
  "bold_claim",
  "question",
  "curiosity",
  "pov_relatable",
  "story_narrative",
] as const;
export const HOOKS_WITH_BACKING = ["statistic", "social_proof", "testimonial", "offer_led"] as const;
export const HOOKS = [...HOOKS_ALWAYS, ...HOOKS_WITH_BACKING] as const;

export const STRATEGIES = ["steal", "double_down", "gap", "control"] as const;
export const ORIGINS = ["generated", "brand_live", "competitor_live"] as const;
export const CREATIVE_STATUSES = ["ranked", "gated_out"] as const;

// "Empty" in the contract: A may write "" or null; both read as null.
const empty = <T extends z.ZodTypeAny>(schema: T) =>
  z.union([schema, z.literal(""), z.null()]).transform((v) => (v === "" ? null : v) as z.output<T> | null);

const prefixedId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[a-z0-9_]+$`));
const unit = z.number().min(0).max(1);

export const brandSchema = z
  .object({
    brand_id: prefixedId("br_"),
    name: z.string().min(1),
    is_client: z.boolean(),
  })
  .strict();

export const conceptSchema = z
  .object({
    concept_id: prefixedId("cpt_"),
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().min(1),
  })
  .strict();

export const segmentSchema = z
  .object({
    segment_id: prefixedId("seg_"),
    name: z.string().min(1),
    description: z.string().min(1),
    share: unit,
    prior_weights: z.record(z.string(), unit),
    quotes: z.array(z.string().min(1)).min(1),
    budget_mean_usd: z.number().positive(),
    budget_sd_usd: z.number().min(0),
    in_market_rate: unit,
  })
  .strict();

export const armSchema = z
  .object({
    arm_id: prefixedId("arm_"),
    angle: empty(z.enum(ANGLES)),
    hook: empty(z.enum(HOOKS)),
    strategy: z.enum(STRATEGIES),
    rationale: z.string().min(1),
    evidence: z.array(z.string()),
  })
  .strict()
  .refine((a) => (a.strategy === "control") === (a.angle === null && a.hook === null), {
    message: "only the control arm has no angle and hook",
  });

export const creativeSchema = z
  .object({
    creative_id: prefixedId("cr_"),
    arm_id: empty(prefixedId("arm_")),
    brand_id: prefixedId("br_"),
    origin: z.enum(ORIGINS),
    headline: z.string().min(1),
    primary_text: z.string().min(1),
    cta: z.string().min(1),
    visual_description: z.string(),
    image_url: empty(z.url()),
    landing_product_id: empty(prefixedId("prd_")),
    days_running: z.number().int().min(0),
    round_created: z.number().int().min(0),
    learning_ids: z.array(z.string()),
    segment_id: empty(prefixedId("seg_")),
    pack_fingerprint: empty(z.string()),
    status: z.enum(CREATIVE_STATUSES),
  })
  .strict();

export const productSchema = z
  .object({
    product_id: prefixedId("prd_"),
    brand_id: prefixedId("br_"),
    name: z.string().min(1),
    price_usd: z.number().min(0),
    subscription_price_usd: z.number().min(0).nullable(),
    rating: z.number().min(0).max(5),
    review_count: z.number().int().min(0),
    page_highlights: z.array(z.string()),
    shipping_note: z.string(),
  })
  .strict();

export type Brand = z.output<typeof brandSchema>;
export type Concept = z.output<typeof conceptSchema>;
export type Segment = z.output<typeof segmentSchema>;
export type Arm = z.output<typeof armSchema>;
export type Creative = z.output<typeof creativeSchema>;
export type Product = z.output<typeof productSchema>;
