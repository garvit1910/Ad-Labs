/** Ad Lab same-path stub (REUSE_MANIFEST §8.2): query keys only; nothing fetches billing. */
export const orgBillingKeys = {
  all: ['billing'] as const,
  org: (id: string) => ['billing', 'org', id] as const,
};
