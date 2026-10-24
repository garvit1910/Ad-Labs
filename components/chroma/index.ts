/**
 * Ad Lab same-path stub (REUSE_MANIFEST §8.2): no Chroma mascot. Renders the
 * caller's fallback icon, as Adcero's Chroma does when it's switched off.
 */
import type { ReactNode } from 'react';

export interface ChromaProps {
  state: 'idle' | 'talking' | 'thinking' | 'happy' | 'uhoh';
  size?: number;
  skin?: string;
  fallback?: ReactNode;
  label?: string;
  className?: string;
}

export function Chroma({ fallback }: ChromaProps): ReactNode {
  return fallback ?? null;
}
