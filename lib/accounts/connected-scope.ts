/**
 * Ad Lab same-path stub (REUSE_MANIFEST §8.2): no connected ad accounts, so the
 * identity step skips its synced own-ad copy.
 */
export async function resolveConnectedAdAccountScope(_params: {
  supabase: unknown;
  organizationId: string;
  platform?: string | null;
}): Promise<{ accounts: unknown[]; accountIds: string[] }> {
  return { accounts: [], accountIds: [] };
}
