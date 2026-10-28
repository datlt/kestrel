import { describe, expect, it } from 'vitest';
import { firstSelectable, lastSelectable, moveSelection } from './selection';

const r = (...types: string[]) => types.map((type) => ({ type }));
// 0 header, 1 a, 2 b, 3 header, 4 c, 5 more
const rows = r('header', 'class', 'class', 'header', 'file', 'more');

describe('selection', () => {
  it('finds the first and last selectable row', () => {
    expect(firstSelectable(rows)).toBe(1);
    expect(lastSelectable(rows)).toBe(5);
    expect(firstSelectable(r('header'))).toBe(-1);
    expect(firstSelectable([])).toBe(-1);
  });

  it('skips headers with Down and Up', () => {
    expect(moveSelection(rows, 2, 'down')).toBe(4);
    expect(moveSelection(rows, 4, 'up')).toBe(2);
  });

  it('wraps around with Down and Up', () => {
    expect(moveSelection(rows, 5, 'down')).toBe(1);
    expect(moveSelection(rows, 1, 'up')).toBe(5);
  });

  it('Home and End go to the first and last row that can be selected', () => {
    expect(moveSelection(rows, 4, 'home')).toBe(1);
    expect(moveSelection(rows, 1, 'end')).toBe(5);
  });

  it('page keys move by a page and stop at the ends', () => {
    const many = r('header', ...Array<string>(30).fill('file'));
    expect(moveSelection(many, 1, 'pageDown', 10)).toBe(11);
    expect(moveSelection(many, 28, 'pageDown', 10)).toBe(30);
    expect(moveSelection(many, 5, 'pageUp', 10)).toBe(1);
  });

  it('page keys skip a header that they land on', () => {
    expect(moveSelection(rows, 1, 'pageDown', 2)).toBe(4);
    expect(moveSelection(rows, 4, 'pageUp', 1)).toBe(2);
  });

  it('starts at the first or last row when nothing is selected', () => {
    expect(moveSelection(rows, -1, 'down')).toBe(1);
    expect(moveSelection(rows, -1, 'up')).toBe(5);
    expect(moveSelection(rows, 0, 'down')).toBe(1);
  });

  it('returns -1 for a list without selectable rows', () => {
    expect(moveSelection(r('header'), 0, 'down')).toBe(-1);
    expect(moveSelection([], -1, 'end')).toBe(-1);
  });
});
