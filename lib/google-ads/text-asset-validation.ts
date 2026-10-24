import type { AssetSpec } from "./campaign-requirements";
import { googleAdTextLength } from "./ad-text-width";

type TextAssetLike = string | { text: string };

function textValue(item: TextAssetLike): string {
  return typeof item === "string" ? item : item.text;
}

export function normalizeTextAssetKey(value: string): string {
  return value.trim().toLowerCase();
}

export function getDuplicateTextAssetIndexes(
  items: readonly TextAssetLike[],
): Set<number> {
  const indexesByKey = new Map<string, number[]>();

  items.forEach((item, index) => {
    const key = normalizeTextAssetKey(textValue(item));
    if (!key) return;
    indexesByKey.set(key, [...(indexesByKey.get(key) ?? []), index]);
  });

  const duplicateIndexes = new Set<number>();
  indexesByKey.forEach((indexes) => {
    if (indexes.length < 2) return;
    indexes.forEach((index) => duplicateIndexes.add(index));
  });

  return duplicateIndexes;
}

export function countUniqueTextAssets(items: readonly TextAssetLike[]): number {
  const keys = new Set<string>();

  items.forEach((item) => {
    const key = normalizeTextAssetKey(textValue(item));
    if (key) keys.add(key);
  });

  return keys.size;
}

export function isTextAssetWithinSpec(
  text: string | undefined,
  spec: AssetSpec,
): boolean {
  const value = text ?? "";

  return (
    value.trim().length >= (spec.minCharacters ?? 1) &&
    // Google's ad-text length: CJK characters count as 2 (H-F10).
    (spec.maxCharacters === undefined || googleAdTextLength(value) <= spec.maxCharacters)
  );
}

export function countUniqueValidTextAssets(
  items: readonly { text: string }[] | undefined,
  spec: AssetSpec,
): number {
  return countUniqueTextAssets(
    (items ?? []).filter((item) => isTextAssetWithinSpec(item.text, spec)),
  );
}
