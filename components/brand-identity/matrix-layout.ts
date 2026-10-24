/**
 * Pure geometry for the performance-matrix scatter plot. Each tactic is a rigid
 * "chip" - a dot with its text label attached beside it - and chips are separated
 * so nothing ever overlaps: no label↔label, no dot↔dot, no label↔foreign-dot, and
 * nothing over a quadrant title. Because the label is rigidly attached to its dot,
 * it is always adjacent, so NO leader lines are ever needed.
 *
 * Accuracy is preserved wherever possible: an isolated chip never moves (its dot
 * stays at the exact data position); only colliding chips get the minimum nudge
 * needed to separate them. The whole module is DOM-free / React-free so the
 * no-overlap guarantee is unit-testable. The only impure inputs are the measured
 * container width/height, which the component supplies from a ResizeObserver.
 *
 *   build chips  → separateChips (relaxation) → lane-grid fallback if needed
 */

import type { QuadrantKey } from './winners-matrix';

export const LAYOUT_CONSTANTS = {
  /** Rendered dot size, px. */
  DOT_DIAMETER: 9,
  DOT_RADIUS: 4.5,
  /** Minimum center-to-center distance between two dots, px. */
  DOT_MIN_GAP: 12,
  /** Inner horizontal padding baked into a label rect (each side), px. */
  PADDING_X: 6,
  /**
   * Per-character advance used to estimate label width. Deliberately ABOVE the
   * true average glyph advance of the 16px label font so the estimate is always
   * ≥ the real text box - the invariant that makes "rects don't overlap ⇒ text
   * doesn't overlap" hold.
   */
  AVG_CHAR_PX: 9.6,
  /** Label rect height (single line), px. Must equal the label span's leading. */
  LINE_HEIGHT: 22,
  /** Extra cushion enforced around every rect during separation, px. */
  LABEL_SAFETY_PX: 4,
  /** Gap between a dot and its attached label, px. */
  DOT_LABEL_GAP: 6,
  /** Relaxation iteration cap (bounded → deterministic). */
  MAX_ITERS: 160,
} as const;

const C = LAYOUT_CONSTANTS;
const EPS = 1e-4;

export interface Rect {
  /** Top-left origin, px. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutItem {
  id: string;
  /** Data position as 0–100 percentages (yPct is win-rate-up). */
  xPct: number;
  yPct: number;
  label: string;
  quadrant: QuadrantKey;
  /**
   * Real rendered text width in px, if the caller measured it (canvas
   * measureText). When present it replaces the per-character estimate so the
   * reserved box exactly fits the text - the label never clips. Falls back to
   * {@link estimateLabelWidth} when omitted (keeps the pure module testable).
   */
  textWidthPx?: number;
}

export interface LayoutInput {
  width: number;
  height: number;
  items: LayoutItem[];
  /**
   * Fixed rectangles chips must not overlap (e.g. quadrant title boxes). Chips
   * are pushed out of these; the rects themselves never move.
   */
  blockedRects?: Rect[];
}

export interface PlacedItem {
  id: string;
  /** Final dot center, px. */
  dot: { x: number; y: number };
  /** Final label rect, px - always adjacent to the dot (no leader needed). */
  label: Rect;
}

export interface LayoutResult {
  items: PlacedItem[];
  /** False when the deterministic lane-grid fallback had to be applied. */
  converged: boolean;
}

interface Bounds {
  width: number;
  height: number;
}

/**
 * A dot + its attached label, as one movable unit. `rect` is the bounding box of
 * both; `dotD*`/`labelD*` are constant offsets of the dot center / label box from
 * the rect's top-left, so moving the rect moves dot and label together.
 */
interface Chip {
  id: string;
  rect: Rect;
  dotDx: number;
  dotDy: number;
  labelDx: number;
  labelDy: number;
  labelW: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/* ── geometry primitives (exported for direct testing) ─────────────────────── */

/** True only when the two rects share positive area. Touching edges ≠ overlap. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** True only when the circle and rect share positive area. Touching ≠ overlap. */
export function circleRectOverlap(
  circle: { x: number; y: number; radius: number },
  rect: Rect
): boolean {
  const cx = clamp(circle.x, rect.x, rect.x + rect.w);
  const cy = clamp(circle.y, rect.y, rect.y + rect.h);
  const dx = circle.x - cx;
  const dy = circle.y - cy;
  return dx * dx + dy * dy < circle.radius * circle.radius;
}

/**
 * Estimated rendered width of a label, px. Monotonic in length and intentionally
 * an over-estimate (see AVG_CHAR_PX) so separation has a safety cushion baked in.
 */
export function estimateLabelWidth(text: string): number {
  return C.PADDING_X * 2 + text.length * C.AVG_CHAR_PX;
}

function clampRectInside(rect: Rect, bounds: Bounds): void {
  rect.x = rect.w >= bounds.width ? 0 : clamp(rect.x, 0, bounds.width - rect.w);
  rect.y = rect.h >= bounds.height ? 0 : clamp(rect.y, 0, bounds.height - rect.h);
}

function center(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function dotCenter(chip: Chip): { x: number; y: number } {
  return { x: chip.rect.x + chip.dotDx, y: chip.rect.y + chip.dotDy };
}

/* ── chip separation ───────────────────────────────────────────────────────── */

/**
 * Iterative relaxation that moves whole chips (dot + label together) until none
 * overlap and every dot pair is ≥ DOT_MIN_GAP apart, also pushing chips out of
 * the blocked title rects and clamping into bounds. Deterministic: fixed order,
 * fixed iteration cap, no randomness. `converged` is false if any chip↔chip
 * overlap or dot-too-close survives the cap.
 */
export function separateChips(
  chips: Chip[],
  bounds: Bounds,
  blockedRects: Rect[] = []
): { chips: Chip[]; converged: boolean } {
  const safety = C.LABEL_SAFETY_PX;
  const minGap = C.DOT_MIN_GAP;
  const items = chips.map((c) => ({ ...c, rect: { ...c.rect } }));
  const n = items.length;

  // Break exact coincidences so push directions are defined.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (
        Math.abs(items[i].rect.x - items[j].rect.x) < EPS &&
        Math.abs(items[i].rect.y - items[j].rect.y) < EPS
      ) {
        const angle = (2 * Math.PI * i) / Math.max(n, 1);
        items[i].rect.x += Math.cos(angle) * 0.5;
        items[i].rect.y += Math.sin(angle) * 0.5;
        break;
      }
    }
  }

  for (let iter = 0; iter < C.MAX_ITERS; iter++) {
    let moved = false;

    // chip ↔ chip (whole bounding boxes)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = items[i].rect;
        const b = items[j].rect;
        const overlapX =
          Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + safety;
        const overlapY =
          Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + safety;
        if (overlapX <= 0 || overlapY <= 0) continue;
        const ca = center(a);
        const cb = center(b);
        if (overlapX < overlapY) {
          const dir = ca.x <= cb.x ? -1 : 1;
          a.x += (dir * overlapX) / 2;
          b.x -= (dir * overlapX) / 2;
        } else {
          const dir = ca.y <= cb.y ? -1 : 1;
          a.y += (dir * overlapY) / 2;
          b.y -= (dir * overlapY) / 2;
        }
        moved = true;
      }
    }

    // dot ↔ dot (covers chips that touch but whose dots face each other)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const di = dotCenter(items[i]);
        const dj = dotCenter(items[j]);
        let dx = dj.x - di.x;
        let dy = dj.y - di.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= minGap) continue;
        if (dist < EPS) {
          const angle = (2 * Math.PI * (i + 1)) / (n + 1);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          dist = 1;
        }
        const push = (minGap - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        items[i].rect.x -= ux * push;
        items[i].rect.y -= uy * push;
        items[j].rect.x += ux * push;
        items[j].rect.y += uy * push;
        moved = true;
      }
    }

    // chip ↔ blocked title: move the chip fully clear via the nearest in-bounds
    // side (for corner titles this resolves to a vertical nudge toward the
    // interior, keeping the over-index reading accurate).
    for (const { rect } of items) {
      for (const blocked of blockedRects) {
        const overlaps =
          rect.x - safety < blocked.x + blocked.w &&
          rect.x + rect.w + safety > blocked.x &&
          rect.y - safety < blocked.y + blocked.h &&
          rect.y + rect.h + safety > blocked.y;
        if (!overlaps) continue;
        const candidates = [
          { x: rect.x, y: blocked.y - rect.h - safety }, // above
          { x: rect.x, y: blocked.y + blocked.h + safety }, // below
          { x: blocked.x - rect.w - safety, y: rect.y }, // left
          { x: blocked.x + blocked.w + safety, y: rect.y }, // right
        ];
        let best: { x: number; y: number } | null = null;
        let bestCost = Infinity;
        for (const cand of candidates) {
          const inBounds =
            cand.x >= 0 &&
            cand.y >= 0 &&
            cand.x + rect.w <= bounds.width &&
            cand.y + rect.h <= bounds.height;
          if (!inBounds) continue;
          const cost = Math.hypot(cand.x - rect.x, cand.y - rect.y);
          if (cost < bestCost) {
            bestCost = cost;
            best = cand;
          }
        }
        if (best) {
          rect.x = best.x;
          rect.y = best.y;
          moved = true;
        }
      }
    }

    for (const { rect } of items) clampRectInside(rect, bounds);
    if (!moved) break;
  }

  let converged = true;
  for (let i = 0; i < n && converged; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rectsOverlap(items[i].rect, items[j].rect)) {
        converged = false;
        break;
      }
      const di = dotCenter(items[i]);
      const dj = dotCenter(items[j]);
      if (Math.hypot(dj.x - di.x, dj.y - di.y) < minGap - 0.5) {
        converged = false;
        break;
      }
    }
  }
  return { chips: items, converged };
}

/**
 * Deterministic last-resort packing: lay chips into a non-overlapping lane grid
 * (rows tall enough for a chip, lanes wide enough for one), shrinking the label
 * to fit its lane. Guarantees zero overlap - chip↔chip and dot↔dot - for any
 * input. Ordered by dot.y then id so the arrangement is stable. Accuracy is
 * sacrificed here; this only runs when relaxation cannot fit the chips.
 */
function laneGridFallback(chips: Chip[], bounds: Bounds): Chip[] {
  const safety = C.LABEL_SAFETY_PX;
  const radius = C.DOT_RADIUS;
  const rowH = C.LINE_HEIGHT + safety;
  const maxRows = Math.max(1, Math.floor(bounds.height / rowH));
  const ordered = [...chips].sort((a, b) => {
    const ya = a.rect.y + a.dotDy;
    const yb = b.rect.y + b.dotDy;
    return ya - yb || (a.id < b.id ? -1 : 1);
  });
  const lanes = Math.max(1, Math.ceil(ordered.length / maxRows));
  const laneW = bounds.width / lanes;
  const capLabelW = Math.max(
    1,
    laneW - safety - 2 * radius - C.DOT_LABEL_GAP
  );

  return ordered.map((c, index) => {
    const row = index % maxRows;
    const col = Math.floor(index / maxRows);
    const labelW = Math.min(c.labelW, capLabelW);
    const w = 2 * radius + C.DOT_LABEL_GAP + labelW;
    const rect: Rect = {
      w,
      h: C.LINE_HEIGHT,
      x: col * laneW + safety / 2,
      y: row * rowH + (rowH - C.LINE_HEIGHT) / 2,
    };
    clampRectInside(rect, bounds);
    // Uniform internal layout: dot on the left, label to its right.
    return {
      id: c.id,
      rect,
      dotDx: radius,
      dotDy: C.LINE_HEIGHT / 2,
      labelDx: 2 * radius + C.DOT_LABEL_GAP,
      labelDy: 0,
      labelW,
    };
  });
}

/* ── orchestrator ──────────────────────────────────────────────────────────── */

/**
 * Full layout for one matrix: non-overlapping dot+label chips. Pure and
 * deterministic.
 */
export function layoutMatrix(input: LayoutInput): LayoutResult {
  const { width, height, items, blockedRects = [] } = input;
  if (items.length === 0 || width <= 0 || height <= 0) {
    return { items: [], converged: true };
  }
  const bounds: Bounds = { width, height };
  const radius = C.DOT_RADIUS;
  const gap = C.DOT_LABEL_GAP;
  const h = C.LINE_HEIGHT;
  const maxLabelW = Math.max(1, width - 2 * radius - gap);

  // Build a rigid chip per tactic: dot at its exact data position, label attached
  // toward the chart interior. Right-half dots get a left label, and vice-versa.
  const chips: Chip[] = items.map((it) => {
    const dotX = clamp((it.xPct / 100) * width, radius, Math.max(radius, width - radius));
    const dotY = clamp(
      ((100 - it.yPct) / 100) * height,
      radius,
      Math.max(radius, height - radius)
    );
    // Prefer the caller's measured text width (exact box ⇒ never clips); fall
    // back to the per-character estimate when unmeasured.
    const rawLabelW =
      it.textWidthPx != null
        ? C.PADDING_X * 2 + it.textWidthPx
        : estimateLabelWidth(it.label);
    const labelW = Math.min(rawLabelW, maxLabelW);
    const chipW = 2 * radius + gap + labelW;
    const labelLeft = dotX > width / 2;
    // rect spans dot + gap + label; dot sits on the outer side, label inner.
    const rectX = labelLeft ? dotX - radius - gap - labelW : dotX - radius;
    const rect: Rect = { x: rectX, y: dotY - h / 2, w: chipW, h };
    clampRectInside(rect, bounds);
    return {
      id: it.id,
      rect,
      dotDx: labelLeft ? chipW - radius : radius,
      dotDy: h / 2,
      labelDx: labelLeft ? 0 : 2 * radius + gap,
      labelDy: 0,
      labelW,
    };
  });

  const sep = separateChips(chips, bounds, blockedRects);
  const final = sep.converged ? sep.chips : laneGridFallback(sep.chips, bounds);

  const placed: PlacedItem[] = final.map((c) => ({
    id: c.id,
    dot: { x: c.rect.x + c.dotDx, y: c.rect.y + c.dotDy },
    label: { x: c.rect.x + c.labelDx, y: c.rect.y + c.labelDy, w: c.labelW, h },
  }));

  return { items: placed, converged: sep.converged };
}
