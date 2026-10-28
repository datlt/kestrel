import { describe, expect, it } from 'vitest';
import { DoubleShiftDetector, type ShiftInput } from './double-shift';

const down = (time: number, extra: Partial<Extract<ShiftInput, { type: 'keydown' }>> = {}): ShiftInput => ({ type: 'keydown', key: 'Shift', time, ...extra });
const up = (time: number): ShiftInput => ({ type: 'keyup', key: 'Shift', time });

function feedAll(inputs: ShiftInput[]): boolean[] {
  const d = new DoubleShiftDetector();
  return inputs.map((i) => d.feed(i));
}

describe('DoubleShiftDetector', () => {
  it('fires on the second Shift key up', () => {
    expect(feedAll([down(0), up(80), down(160), up(240)])).toEqual([false, false, false, true]);
  });

  it('does not fire when the gap is longer than 350 ms', () => {
    expect(feedAll([down(0), up(80), down(500), up(560)])).toEqual([false, false, false, false]);
  });

  it('counts a late second press as a new first press', () => {
    const d = new DoubleShiftDetector();
    const out = [down(0), up(50), down(600), up(650), down(700), up(750)].map((i) => d.feed(i));
    expect(out).toEqual([false, false, false, false, false, true]);
  });

  it('ignores a Shift key that is held for a long time', () => {
    expect(feedAll([down(0), up(600), down(650), up(700)])).toEqual([false, false, false, false]);
    expect(feedAll([down(0), up(50), down(100), up(900)])).toEqual([false, false, false, false]);
  });

  it('ignores key repeat while Shift is held', () => {
    expect(feedAll([down(0), down(30, { repeat: true }), up(80), down(160), up(240)])).toEqual([false, false, false, false, true]);
  });

  it('starts again after another key', () => {
    const letter: ShiftInput = { type: 'keydown', key: 'a', time: 100 };
    expect(feedAll([down(0), up(50), letter, down(150), up(200)])).toEqual([false, false, false, false, false]);
  });

  it('starts again after another key between the two presses of a Shift-letter chord', () => {
    const letter: ShiftInput = { type: 'keydown', key: 'A', time: 20 };
    expect(feedAll([down(0), letter, up(60), down(100), up(150)])).toEqual([false, false, false, false, false]);
  });

  it('starts again after a mouse button', () => {
    expect(feedAll([down(0), up(50), { type: 'mouse', time: 80 }, down(120), up(170)])).toEqual([false, false, false, false, false]);
  });

  it('starts again after the window loses the focus', () => {
    expect(feedAll([down(0), up(50), { type: 'blur', time: 80 }, down(120), up(170)])).toEqual([false, false, false, false, false]);
  });

  it('ignores presses during an IME composition', () => {
    expect(feedAll([down(0, { composing: true }), up(50), down(100, { composing: true }), up(150)])).toEqual([false, false, false, false]);
  });

  it('does not fire three times for three taps in a row', () => {
    const d = new DoubleShiftDetector();
    const out = [down(0), up(40), down(80), up(120), down(160), up(200)].map((i) => d.feed(i));
    expect(out).toEqual([false, false, false, true, false, false]);
  });

  it('can fire again after a double Shift', () => {
    const d = new DoubleShiftDetector();
    const out = [down(0), up(40), down(80), up(120), down(1000), up(1040), down(1080), up(1120)].map((i) => d.feed(i));
    expect(out.filter(Boolean).length).toBe(2);
  });
});
