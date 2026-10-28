// Fuzzy matcher for the quick pick and the command palette.
//
// It scores a query against a text. The idea comes from the "fzy" algorithm:
// every query letter must appear in the text in the same order, and the best
// path through the text gets the highest score. Matches get a bonus when they
// are consecutive, or when they start a word (after `/`, `-`, `_`, space, `.`)
// or a camelCase hump. Gaps cost a small penalty.
//
// No DOM here, so it runs in unit tests.

export interface FuzzyResult {
  score: number;
  /** Indexes in the text of the matched characters (ascending). */
  indexes: number[];
}

const SCORE_MIN = -Infinity;
const GAP_LEADING = -0.005;
const GAP_TRAILING = -0.005;
const GAP_INNER = -0.01;
const MATCH_CONSECUTIVE = 1.0;
const BONUS_SLASH = 0.9;
const BONUS_WORD = 0.8;
const BONUS_CAMEL = 0.7;
const BONUS_DOT = 0.6;
const BONUS_START = 0.9;
/** Longer texts use a greedy match, so one call stays cheap. */
const MAX_DP_TEXT = 256;
const MAX_DP_QUERY = 64;

function lowerCode(c: number): number {
  if (c >= 65 && c <= 90) return c + 32;
  if (c < 128) return c;
  return String.fromCharCode(c).toLowerCase().charCodeAt(0);
}

function isUpper(c: number): boolean {
  return (c >= 65 && c <= 90) || (c > 127 && String.fromCharCode(c).toLowerCase() !== String.fromCharCode(c));
}

function isLowerOrDigit(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
}

function bonusAfter(prev: number, cur: number): number {
  switch (prev) {
    case 47: // /
    case 92: // \
      return BONUS_SLASH;
    case 45: // -
    case 95: // _
    case 32: // space
    case 58: // :
      return BONUS_WORD;
    case 46: // .
      return BONUS_DOT;
  }
  if (isLowerOrDigit(prev) && isUpper(cur)) return BONUS_CAMEL;
  return 0;
}

// Scratch buffers, grown when needed.
let bufD = new Float64Array(0);
let bufM = new Float64Array(0);
const bonusBuf = new Float64Array(MAX_DP_TEXT);

/** Prepares a query once, so a list of items does not repeat the work. */
export function prepareQuery(query: string): Uint16Array {
  const q = new Uint16Array(query.length);
  for (let i = 0; i < query.length; i++) q[i] = lowerCode(query.charCodeAt(i));
  return q;
}

/** Cheap check: are all query letters in the text, in order? */
function isSubsequence(q: Uint16Array, text: string): boolean {
  let qi = 0;
  const n = text.length;
  for (let j = 0; j < n && qi < q.length; j++) {
    if (lowerCode(text.charCodeAt(j)) === q[qi]) qi++;
  }
  return qi === q.length;
}

function greedy(q: Uint16Array, text: string): FuzzyResult {
  // Take the last possible matching letters from the end, then walk forward
  // to make runs tight. Simple and good enough for long texts.
  const indexes: number[] = [];
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let j = 0; j < text.length && qi < q.length; j++) {
    const c = text.charCodeAt(j);
    if (lowerCode(c) !== q[qi]) continue;
    indexes.push(j);
    score += j === prev + 1 ? MATCH_CONSECUTIVE : j === 0 ? BONUS_START : bonusAfter(text.charCodeAt(j - 1), c);
    prev = j;
    qi++;
  }
  return { score: score - text.length * 0.01, indexes };
}

/**
 * Matches `query` against `text`. Returns null when the letters are not all
 * in the text. Matching ignores case. A higher score is a better match.
 * An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string | Uint16Array, text: string): FuzzyResult | null {
  const q = typeof query === 'string' ? prepareQuery(query) : query;
  const m = q.length;
  const n = text.length;
  if (m === 0) return { score: 0, indexes: [] };
  if (m > n) return null;
  if (!isSubsequence(q, text)) return null;
  if (n > MAX_DP_TEXT || m > MAX_DP_QUERY) return greedy(q, text);

  // Exact match is always the best.
  if (m === n) {
    const indexes: number[] = [];
    for (let i = 0; i < n; i++) indexes.push(i);
    return { score: Infinity, indexes };
  }

  for (let j = 0; j < n; j++) {
    const c = text.charCodeAt(j);
    bonusBuf[j] = j === 0 ? BONUS_START : bonusAfter(text.charCodeAt(j - 1), c);
  }

  const size = n * m;
  if (bufD.length < size) {
    bufD = new Float64Array(size);
    bufM = new Float64Array(size);
  }
  const D = bufD;
  const M = bufM;

  for (let i = 0; i < m; i++) {
    let prevScore = SCORE_MIN;
    const gap = i === m - 1 ? GAP_TRAILING : GAP_INNER;
    const qc = q[i];
    const row = i * n;
    for (let j = 0; j < n; j++) {
      if (lowerCode(text.charCodeAt(j)) === qc) {
        let score = SCORE_MIN;
        if (i === 0) {
          score = j * GAP_LEADING + bonusBuf[j];
        } else if (j > 0) {
          const diag = (i - 1) * n + (j - 1);
          score = Math.max(M[diag] + bonusBuf[j], D[diag] + MATCH_CONSECUTIVE);
        }
        D[row + j] = score;
        prevScore = Math.max(score, prevScore + gap);
        M[row + j] = prevScore;
      } else {
        D[row + j] = SCORE_MIN;
        prevScore = prevScore + gap;
        M[row + j] = prevScore;
      }
    }
  }

  const indexes = new Array<number>(m);
  let matchRequired = false;
  let j = n - 1;
  for (let i = m - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      const d = D[i * n + j];
      if (d !== SCORE_MIN && (matchRequired || d === M[i * n + j])) {
        matchRequired = i > 0 && j > 0 && M[i * n + j] === D[(i - 1) * n + (j - 1)] + MATCH_CONSECUTIVE;
        indexes[i] = j;
        j--;
        break;
      }
    }
  }
  return { score: M[(m - 1) * n + (n - 1)], indexes };
}

export interface Scored<T> {
  item: T;
  score: number;
  labelIndexes: number[];
  descriptionIndexes: number[];
}

/**
 * Filters and sorts items. Best score first. Items with the same score keep
 * their original order. Labels count fully. A match in the description counts
 * less. An empty query returns all items in order.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  label: (item: T) => string,
  description?: (item: T) => string | undefined,
): Scored<T>[] {
  if (!query) return items.map((item) => ({ item, score: 0, labelIndexes: [], descriptionIndexes: [] }));
  const q = prepareQuery(query);
  const out: (Scored<T> & { order: number })[] = [];
  for (let k = 0; k < items.length; k++) {
    const item = items[k];
    const lm = fuzzyMatch(q, label(item));
    if (lm) {
      out.push({ item, score: lm.score, labelIndexes: lm.indexes, descriptionIndexes: [], order: k });
      continue;
    }
    const desc = description?.(item);
    if (desc) {
      const dm = fuzzyMatch(q, desc);
      if (dm) out.push({ item, score: dm.score - 5, labelIndexes: [], descriptionIndexes: dm.indexes, order: k });
    }
  }
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out;
}
