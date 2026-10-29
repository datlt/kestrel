// Small helpers for the layout animation and the highlight fade.

import { easeInOut } from './camera';

/** `out[i] = from[i] + (to[i] - from[i]) * ease(t)`. Returns `out`. */
export function lerpPositions(from: Float64Array, to: Float64Array, t: number, out: Float64Array): Float64Array {
  const k = easeInOut(Math.min(1, Math.max(0, t)));
  for (let i = 0; i < out.length; i++) out[i] = from[i] + (to[i] - from[i]) * k;
  return out;
}

/** Moves `value` toward `target` by at most `dt / ms` (a linear fade that takes `ms` for the full range 0 to 1). */
export function approach(value: number, target: number, dt: number, ms: number): number {
  const step = dt / ms;
  if (value < target) return Math.min(target, value + step);
  return Math.max(target, value - step);
}
