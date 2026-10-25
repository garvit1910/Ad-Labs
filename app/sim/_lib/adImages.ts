// Which run's ad images (sim/demo/ad-images.json) belong on the run being viewed. Images are
// rendered for one run, but an offline replay of it (sim:replay) reads exactly the same states, so
// it shows the same images. A run's signature is the cache keys of its first sim day's first feed
// decisions: identical for a run and its replays, different for any other run. Shared with
// scripts/sim-images.ts, which records each run's signature.

const SIGNATURE_ROWS = 12;

export function runSignature(feed: readonly { tick: number; shopper: string; options: string }[]): string {
  const first = Math.min(...feed.map((d) => d.tick));
  return feed
    .filter((d) => d.tick === first)
    .sort((a, b) => a.shopper.localeCompare(b.shopper))
    .slice(0, SIGNATURE_ROWS)
    .map((d) => {
      try {
        return String((JSON.parse(d.options) as { state_hash?: string }).state_hash ?? '').slice(0, 16);
      } catch {
        return '';
      }
    })
    .join(',');
}

// The source run whose images apply to `runId`: the run itself, else the run whose recorded
// signature this run's decisions reproduce. Null while nothing matches.
export function imageRunFor(
  runId: string,
  signature: string,
  runs: Readonly<Record<string, { signature: string }>>,
  hasImages: (runId: string) => boolean,
): string | null {
  if (hasImages(runId)) return runId;
  if (!signature) return null;
  return Object.entries(runs).find(([id, r]) => r.signature === signature && hasImages(id))?.[0] ?? null;
}
