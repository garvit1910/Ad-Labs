/**
 * Layer 3 reconciler — PURE diff of candidate facts against the live fact
 * set of one (brand, section). Invariants (regression-tested):
 *
 *   1. A HUMAN-CONFIRMED fact (status 'confirmed') is NEVER auto-superseded.
 *      A contradicting candidate becomes a brand_fact_suggestions row; only
 *      the founder's accept supersedes it (source 'user_stated').
 *   2. Content-identical candidates refresh metrics/evidence in place —
 *      deterministic counts stay fresh on confirmed facts without touching
 *      the confirmed statement/details/confidence.
 *   3. Otherwise confidence wins, then recency: an unconfirmed live fact is
 *      superseded when the candidate's confidence is >= the live one's
 *      (the candidate is by construction newer); a weaker candidate is
 *      dropped (kept_live).
 *   4. A fact identity whose LATEST version was rejected by the founder is
 *      suppressed — promotion must not resurrect it next run.
 *
 * Persistence executes the plan as: stamp old valid_to FIRST, then insert
 * the new version (the partial unique live-identity index allows one live
 * row per key; a crash between the steps leaves no live row, which the next
 * run re-inserts).
 */
import type { CandidateFact, LiveFact, ReconcilePlan } from './types';

/** Whitespace/case-insensitive statement equality — the "same content" test
 * for metric refreshes. */
export function statementsEqual(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

export interface ReconcileInput {
  candidates: CandidateFact[];
  /** Live rows (valid_to IS NULL) for the same brand + section(s). */
  liveFacts: LiveFact[];
  /** factKeys whose LATEST version is founder-rejected (no live row). */
  rejectedKeys?: ReadonlySet<string>;
}

export function reconcileFacts(input: ReconcileInput): ReconcilePlan {
  const plan: ReconcilePlan = {
    inserts: [],
    supersedes: [],
    suggestions: [],
    metricRefreshes: [],
    noops: [],
  };
  const liveByKey = new Map<string, LiveFact>();
  for (const fact of input.liveFacts) {
    liveByKey.set(`${fact.section}:${fact.factKey}`, fact);
  }

  for (const candidate of input.candidates) {
    const key = `${candidate.section}:${candidate.factKey}`;

    if (input.rejectedKeys?.has(key)) {
      plan.noops.push({
        factKey: candidate.factKey,
        reason: 'rejected_identity',
      });
      continue;
    }

    const live = liveByKey.get(key);
    if (!live) {
      plan.inserts.push(candidate);
      continue;
    }

    if (statementsEqual(live.statement, candidate.statement)) {
      plan.metricRefreshes.push({ liveFactId: live.id, candidate });
      continue;
    }

    if (live.status === 'confirmed') {
      plan.suggestions.push({
        liveFactId: live.id,
        candidate,
        reason:
          `New ${candidate.source.replace(/_/g, ' ')} evidence proposes a ` +
          `different statement for a founder-confirmed fact.`,
      });
      // The founder's STATEMENT stands until they accept the suggestion, but
      // the numbers under it are a recomputation of the current corpus, not a
      // competing claim — same reasoning as the kept_live branch below. This
      // branch is the one that matters most: a confirmed fact can NEVER be
      // retired, so without a refresh its metrics freeze permanently at
      // whatever the corpus was when it was confirmed. And it is the COMMON
      // path, not an edge case — the cluster pipeline re-words theme
      // summaries almost every run ("Customers repeatedly say they like the
      // flavor" -> "Customers simply say they like the flavor"), so a
      // re-worded summary lands here rather than in the identical-content
      // refresh above. Live incident (Magic Spoon dev, 2026-07-23): 16 of 18
      // confirmed VOC facts matched a fresh candidate and had their corrected
      // metrics dropped, leaving `friendly-service` headlining Chapter 03 at
      // frequency 150 — 147 of them foreign Google-Maps reviews — through a
      // full re-cluster and two promote passes.
      plan.metricRefreshes.push({ liveFactId: live.id, candidate });
      continue;
    }

    if (candidate.confidence >= live.confidence) {
      plan.supersedes.push({ liveFactId: live.id, candidate });
    } else {
      // The live STATEMENT wins on confidence (invariant 3), but the metrics
      // are a recomputation of the current corpus, not a competing claim —
      // so they refresh anyway. Without this a fact can advertise evidence
      // volume its corpus no longer supports, and the error is
      // self-preserving: inflated frequency -> inflated confidence -> the
      // inflated fact outranks its own corrected re-derivation and is kept
      // forever, while the retire pass can't reach it because its key still
      // counts as "fresh". Live incident (2026-07-07 → 07-23): foreign
      // Google-Maps reviews inflated Magic Spoon's `initial-skepticism` to
      // frequency 8/confidence 0.82, and the clean 5-phrase re-derivation
      // was dropped as "weaker".
      plan.metricRefreshes.push({ liveFactId: live.id, candidate });
      plan.noops.push({ factKey: candidate.factKey, reason: 'kept_live' });
    }
  }

  return plan;
}
