/** Ad Lab same-path stub (REUSE_MANIFEST §8.2): no auth; route handlers are local. */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  return { 'Content-Type': 'application/json' };
}
