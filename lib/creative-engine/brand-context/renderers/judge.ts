/**
 * Judge renderer v2 — one pack in, a binary pass/fail checklist out. One item
 * per rules-slot entry (slot order) plus the structural items the image
 * renderer unconditionally imposes (a judge that only checked pack rules
 * would pass a creative that violated the render contract).
 *
 * v2 structural items mirror the clean-image doctrine: no ADDED text
 * (packaging text is expected and allowed), product fidelity to the
 * reference images (only when the pack carries product_image assets), and
 * scene relevance. Each item carries `enforced`: objective checks
 * (no-added-text, product-fidelity) enforce immediately under the
 * enforce_structural gate mode; judgment calls (scene-relevance) and pack
 * rules stay advisory until the gold-set calibration
 * (scripts/eval-creative-judge-calibration.ts) ratifies them.
 *
 * v3 (2026-08-05): rule statements are whitespace-collapsed before they are
 * quoted into a requirement — a newline in a review-derived rule could
 * otherwise forge an extra checklist line in the judge prompt.
 *
 * v4 (2026-09-22): scene relevance is rewritten to match image renderer v5 —
 * the r2 text ("plausibly motivated by real product usage") failed any
 * stylised or conceptual composition the image prompt now invites, so the
 * item moves to @r3: every element must relate to the product, its
 * ingredients, its benefit, or its customer; conceptual staging is allowed.
 *
 * Phase 6 embeds this checklist in the multimodal judge prompt behind the
 * existing PolicyCheckFn seam (generation/gates.ts) — item ids map verdicts
 * back to exact rule versions, so items are structured, never prose.
 */
import { type BrandContextPack } from '../types';
import {
  assertRendererVersion,
  collapseWhitespace,
  optionalString,
  requireString,
} from './shared';

export interface JudgeChecklistItem {
  /** Stable id: '<rowId>@v<version>' for rules; 'structural_*@rN' for fixed checks. */
  id: string;
  source: 'rule' | 'structural';
  /** A statement that must be TRUE of the creative to pass. Binary — no partial credit. */
  requirement: string;
  /**
   * Whether a failing verdict BLOCKS the candidate under the
   * enforce_structural gate mode (full 'enforce' mode enforces everything).
   * Advisory items still persist their verdicts for calibration.
   */
  enforced: boolean;
}

export interface JudgeRender {
  checklist: JudgeChecklistItem[];
}

export function renderJudgeChecklist(pack: BrandContextPack): JudgeRender {
  assertRendererVersion(pack, 'judge');
  const ruleItems: JudgeChecklistItem[] = pack.slots.rules.map((entry) => ({
    id: `${entry.id}@v${entry.version}`,
    source: 'rule' as const,
    requirement: `The copy and image comply with this brand rule: "${collapseWhitespace(
      requireString(entry, 'statement', 'rules'),
    )}"`,
    // Pack rules are judgment calls — advisory until calibration ratifies.
    enforced: false,
  }));
  const hasProductReference = pack.slots.assets.some(
    (entry) => optionalString(entry, 'kind') === 'product_image',
  );
  // The @rN suffix pins the identity of the structural REQUIREMENT TEXT, not
  // the renderer version number: these ids are persisted verdict join keys
  // (gate_results items, the lineage checklist join, and pipeline-repair's
  // fidelity check), so they move only when the requirement itself is
  // rewritten. v3 changed no structural text — it only whitespace-collapses
  // pack rule statements — so the ids stay @r2 and historical verdicts keep
  // resolving. v4 rewrote ONLY the scene-relevance requirement, so only that
  // item moved to @r3 (r2 verdicts judged a different, stricter question).
  const structuralItems: JudgeChecklistItem[] = [
    {
      id: 'structural_no_added_text@r2',
      source: 'structural',
      requirement:
        "No text, headline, caption, banner band, CTA button, or watermark has been ADDED to the image. Text printed on the product's own packaging or label is expected and allowed. A thin bottom compliance-disclaimer strip is a sanctioned overlay and allowed.",
      enforced: true,
    },
    // Only meaningful when a real product reference grounded the generation.
    ...(hasProductReference
      ? [
          {
            id: 'structural_product_fidelity@r2',
            source: 'structural' as const,
            requirement:
              'The hero product matches the reference product: same packaging shape, label design, printed text, logo, and colors — not a redesigned, blurred, or generic substitute.',
            enforced: true,
          },
        ]
      : []),
    {
      id: 'structural_scene_relevance@r3',
      source: 'structural',
      requirement:
        'Every element of the image relates to the product, its ingredients, its benefit, or its customer; stylised, conceptual, or editorial compositions are acceptable. There are no unrelated or unmotivated people, devices, screens, venues, or props.',
      // Judgment call — calibrate against shadow data before enforcing.
      enforced: false,
    },
  ];
  return { checklist: [...ruleItems, ...structuralItems] };
}
