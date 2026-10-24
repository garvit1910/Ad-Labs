/**
 * Generic ad-speak the copywriter must never produce — the phrases that made
 * every brand's ads read identical ("Style Meets Value: Shop Smart Today!").
 * Named in the copy renderer's task section
 * (`brand-context/renderers/copy.ts`, which re-exports this constant so the
 * renderer contract and every existing import path are unchanged) AND
 * enforced deterministically post-generation (`findBannedPhrases`).
 * Case-insensitive substrings.
 *
 * Lives here (ZERO imports) so the client-safe brand check can share the ONE
 * list with the renderer and the generation-time guards.
 */
export const BANNED_AD_SPEAK = [
  'shop smart',
  'style meets value',
  'exclusive deals',
  "don't miss out",
  'elevate your',
  'unleash',
  'discover the difference',
  'quality you can trust',
  'your one-stop shop',
  'treat yourself',
  'satisfaction guaranteed',
  'limited time only',
  'best-kept secret',
  'game-changer',
  'shop the look',
] as const;
