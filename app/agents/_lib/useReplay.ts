'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { type ChatBubble, replayDelays } from './chat';

// Replays one session's bubbles at demo speed: each bubble waits its (clamped) real gap, with the
// sender "typing" for the last ~0.6s of it. Nothing is written anywhere; it only slices the thread.

export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

export interface Replay {
  active: boolean;
  sessionId: string | null;
  shown: number;
  total: number;
  playing: boolean;
  speed: Speed;
  /** Party id typing the next bubble, or null. */
  typing: string | null;
  start: (sessionId: string) => void;
  toggle: () => void;
  setSpeed: (speed: Speed) => void;
  skip: () => void;
  exit: () => void;
}

export function useReplay(bubbles: readonly ChatBubble[]): Replay {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [typing, setTyping] = useState<string | null>(null);
  const total = bubbles.length;
  const delays = useMemo(() => replayDelays(bubbles, speed), [bubbles, speed]);

  const running = sessionId !== null && playing && shown < total;

  useEffect(() => {
    if (!running) return;
    const wait = delays[shown];
    const lead = Math.min(650, wait * 0.6);
    const next = bubbles[shown]?.from ?? null;
    const a = setTimeout(() => setTyping(next), wait - lead);
    const b = setTimeout(() => {
      setTyping(null);
      setShown((n) => n + 1);
    }, wait);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [running, shown, delays, bubbles]);

  const start = useCallback((id: string) => {
    setSessionId(id);
    setShown(0);
    setTyping(null);
    setPlaying(true);
  }, []);
  const toggle = useCallback(() => {
    if (shown >= total) {
      setShown(0);
      setPlaying(true);
    } else setPlaying((p) => !p);
  }, [shown, total]);
  const skip = useCallback(() => {
    setShown(total);
    setPlaying(false);
    setTyping(null);
  }, [total]);
  const exit = useCallback(() => {
    setSessionId(null);
    setPlaying(false);
    setTyping(null);
  }, []);

  return { active: sessionId !== null, sessionId, shown: Math.min(shown, total), total, playing: running, speed, typing: running ? typing : null, start, toggle, setSpeed, skip, exit };
}
