// Calibration ("The Jev calls" > "Calibration"): one log-odds offset per gate,
//   p_cal = σ(logit(p_raw) + b_gate)
// B2 applies the offsets; B3 fits them on the warm-up round by bisection. Until then the
// offsets are 0, which leaves every probability as Jev returned it apart from the clamp.

export type Gate = "tap" | "stay" | "buy";
export type Offsets = Record<Gate, number>;

export const ZERO_OFFSETS: Offsets = { tap: 0, stay: 0, buy: 0 };

// Jev returns exact 0s and 1s on Choice answers (SPIKE.md), which have no logit.
export const P_MIN = 0.005;
export const P_MAX = 0.995;

export function logit(p: number): number {
  return Math.log(p / (1 - p));
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function calibrate(pRaw: number, offset: number): number {
  const p = Math.min(P_MAX, Math.max(P_MIN, pRaw));
  // σ(logit(p)) only round-trips to within float error; a zero offset keeps p exactly.
  return offset === 0 ? p : sigmoid(logit(p) + offset);
}
