/**
 * Pure renderer barrel — safe to import from anywhere (no IO). Non-route
 * code should import THIS path (`.../brand-context/renderers`), never the
 * main brand-context barrel (mixed pure+IO — routes only).
 */
export {
  assertKnownAspectRatio,
  assertRendererVersion,
  IMAGE_REFERENCE_ASSET_CAP,
  KNOWN_ASPECT_RATIOS,
  malformedRow,
  noteList,
  optionalString,
  requireString,
  STORY_SAFE_ZONE_9_16,
  type RendererKind,
} from './shared';
export { BANNED_AD_SPEAK, renderCopyPrompt, type CopyRender } from './copy';
export {
  renderImagePrompt,
  type ImageReferenceAsset,
  type ImageRender,
  type ImageRenderSegments,
} from './image';
export {
  renderJudgeChecklist,
  type JudgeChecklistItem,
  type JudgeRender,
} from './judge';
