/**
 * Ad Lab is single-tenant. Adcero's tables and job payloads keep their
 * `organization_id` column; every row carries this one constant id
 * (REUSE_MANIFEST §8.1). There is no organizations table.
 */
export const ADLAB_ORG_ID = '00000000-0000-4000-8000-000000000001';
export const ADLAB_ORG_NAME = 'Ad Lab';
