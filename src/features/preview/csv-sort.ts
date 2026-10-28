// Sorting rows of a CSV table. No DOM code.

import { cellText, type CsvTable } from './csv-parse';

/** A number such as `12`, `-3.5`, `1e6`, `$20` or `45%`. Returns NaN for other text. */
export function parseNumber(s: string): number {
  const t = s.trim().replace(/^[$€£¥]\s*/, '').replace(/\s*%$/, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return NaN;
  return Number(t);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Row numbers `first` up to `table.rows - 1`, ordered by column `col`.
 * A column is numeric when every non-empty cell is a number. Then it sorts as
 * numbers. Other columns sort as text, and digits inside text compare as numbers.
 * Empty cells are always last. Equal cells keep the file order.
 */
export function sortRows(table: CsvTable, text: string, first: number, col: number, descending: boolean): Uint32Array {
  const count = Math.max(0, table.rows - first);
  const order = new Uint32Array(count);
  for (let k = 0; k < count; k++) order[k] = first + k;
  const values: string[] = new Array(count);
  let numeric = true;
  let seen = false;
  const nums = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    const v = cellText(table, text, first + k, col);
    values[k] = v;
    if (v.trim() === '') {
      nums[k] = NaN;
      continue;
    }
    if (numeric) {
      const x = parseNumber(v);
      if (Number.isNaN(x)) numeric = false;
      else {
        nums[k] = x;
        seen = true;
      }
    }
  }
  numeric = numeric && seen;
  const sign = descending ? -1 : 1;
  const empty = (k: number) => values[k].trim() === '';
  order.sort((a, b) => {
    const ka = a - first;
    const kb = b - first;
    const ea = empty(ka);
    const eb = empty(kb);
    if (ea || eb) return ea === eb ? a - b : ea ? 1 : -1;
    const r = numeric ? nums[ka] - nums[kb] : collator.compare(values[ka], values[kb]);
    return r !== 0 ? sign * r : a - b;
  });
  return order;
}
