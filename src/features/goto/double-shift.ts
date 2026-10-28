// Detects "Shift pressed twice". No DOM here, so the rules are easy to test.
//
// A double Shift is: Shift down, Shift up, Shift down, Shift up. The time from
// the first key up to the second key down is at most 350 ms. Each key is held
// at most 350 ms. Any other key, a mouse button, an IME composition or a window
// blur between the presses starts again.

export const DOUBLE_SHIFT_MS = 350;

export type ShiftInput =
  | { type: 'keydown'; key: string; time: number; repeat?: boolean; composing?: boolean }
  | { type: 'keyup'; key: string; time: number }
  | { type: 'mouse'; time: number }
  | { type: 'blur'; time: number };

export type ShiftState =
  | { phase: 'idle' }
  | { phase: 'down1'; since: number }
  | { phase: 'up1'; since: number }
  | { phase: 'down2'; since: number };

export const SHIFT_IDLE: ShiftState = { phase: 'idle' };

export interface ShiftStep {
  state: ShiftState;
  /** True when this input completed a double Shift. */
  fire: boolean;
}

const idle = (): ShiftStep => ({ state: SHIFT_IDLE, fire: false });

/** One step of the state machine. */
export function stepShift(state: ShiftState, input: ShiftInput, windowMs = DOUBLE_SHIFT_MS): ShiftStep {
  if (input.type === 'mouse' || input.type === 'blur') return idle();
  const isShift = input.key === 'Shift';

  if (input.type === 'keydown') {
    if (input.composing) return idle();
    if (!isShift) return idle();
    // Holding the key sends repeated key down events. They change nothing.
    if (input.repeat) return { state, fire: false };
    switch (state.phase) {
      case 'idle':
      case 'down1':
      case 'down2':
        return { state: { phase: 'down1', since: input.time }, fire: false };
      case 'up1':
        if (input.time - state.since <= windowMs) return { state: { phase: 'down2', since: input.time }, fire: false };
        return { state: { phase: 'down1', since: input.time }, fire: false };
    }
  }

  // key up
  if (!isShift) {
    // A key that went down earlier can come up now. Only reset when we wait for the second press.
    return state.phase === 'idle' ? { state, fire: false } : idle();
  }
  switch (state.phase) {
    case 'down1':
      if (input.time - state.since <= windowMs) return { state: { phase: 'up1', since: input.time }, fire: false };
      return idle();
    case 'down2':
      return { state: SHIFT_IDLE, fire: input.time - state.since <= windowMs };
    default:
      return idle();
  }
}

/** Keeps the state between inputs. */
export class DoubleShiftDetector {
  private state: ShiftState = SHIFT_IDLE;

  constructor(private readonly windowMs = DOUBLE_SHIFT_MS) {}

  /** Returns true when the input completed a double Shift. */
  feed(input: ShiftInput): boolean {
    const step = stepShift(this.state, input, this.windowMs);
    this.state = step.state;
    return step.fire;
  }

  reset(): void {
    this.state = SHIFT_IDLE;
  }
}
