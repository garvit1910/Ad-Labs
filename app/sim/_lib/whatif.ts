// The what-if calls: re-ask Jev one of the sim's questions about an edited state, through the
// cached route in app/api/sim/whatif. Shared by the inspector and the pinned shopper's story.

export type Answers = Record<string, { type: string; noul?: number; probabilities?: Record<string, number> }>;
export type Asked = { answers: Answers; cached: boolean };

export async function ask(state: string, questions: object): Promise<Asked> {
  const res = await fetch('/api/sim/whatif', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
  const json = (await res.json()) as { answers?: Answers; cached?: boolean; error?: string };
  if (!res.ok || !json.answers) throw new Error(json.error ?? `HTTP ${res.status}`);
  return { answers: json.answers, cached: Boolean(json.cached) };
}
