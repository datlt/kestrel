// Size and rows of one node box. The text widths come from a `measure`
// function, so this file works without a DOM and can be tested.

import type { DiagramMember, DiagramNode } from '../../ipc/code';
import { displayName, langLabel, memberLine, stereotypeLines, typeParamsText, visibleMembers } from './model';
import type { MembersMode } from './options';

export const FONT_SIZE = { stereotype: 10, title: 13, member: 11.5, badge: 9, edgeLabel: 10.5 };
const PAD_X = 10;
const STEREO_H = 13;
const TITLE_H = 22;
const ROW_H = 16;
const COMPARTMENT_PAD = 4;
const HEAD_PAD_TOP = 5;
const HEAD_PAD_BOTTOM = 3;
const BADGE_GAP = 6;
const MIN_W = 96;
const MAX_W = 420;

export type Measure = (text: string, fontSize: number, bold: boolean) => number;

export interface BoxRow {
  kind: 'stereotype' | 'title' | 'field' | 'method' | 'more';
  text: string;
  /** Second part of the title (type parameters), drawn in normal weight. */
  suffix?: string;
  /** Top of the row, relative to the box. */
  y: number;
  height: number;
  member?: DiagramMember;
  /** Index of the member in `node.fields` or `node.methods`. */
  memberIndex?: number;
}

export interface NodeBox {
  id: string;
  width: number;
  height: number;
  rows: BoxRow[];
  /** y positions of the lines between the header and the compartments. */
  separators: number[];
  badge: { text: string; width: number } | null;
}

export function computeNodeBox(node: DiagramNode, mode: MembersMode, measure: Measure): NodeBox {
  const rows: BoxRow[] = [];
  const separators: number[] = [];
  let y = HEAD_PAD_TOP;
  let maxText = 0;

  for (const s of stereotypeLines(node)) {
    rows.push({ kind: 'stereotype', text: s, y, height: STEREO_H });
    maxText = Math.max(maxText, measure(s, FONT_SIZE.stereotype, false));
    y += STEREO_H;
  }

  const suffix = typeParamsText(node);
  rows.push({ kind: 'title', text: node.name, suffix: suffix || undefined, y, height: TITLE_H });
  const badgeText = langLabel(node.lang);
  const badge = badgeText ? { text: badgeText, width: measure(badgeText, FONT_SIZE.badge, true) + 8 } : null;
  const titleW = measure(node.name, FONT_SIZE.title, true) + (suffix ? measure(suffix, FONT_SIZE.title, false) : 0);
  // The badge sits at the right end of the title row.
  const titleRowW = titleW + (badge ? badge.width + BADGE_GAP : 0);
  maxText = Math.max(maxText, titleRowW);
  y += TITLE_H + HEAD_PAD_BOTTOM;

  const { fields, methods } = visibleMembers(node, mode);
  const addCompartment = (list: DiagramMember[], kind: 'field' | 'method', more: boolean) => {
    if (list.length === 0 && !more) return;
    separators.push(y);
    y += COMPARTMENT_PAD;
    list.forEach((m, i) => {
      const text = memberLine(m);
      rows.push({ kind, text, y, height: ROW_H, member: m, memberIndex: i });
      maxText = Math.max(maxText, measure(text, FONT_SIZE.member, false));
      y += ROW_H;
    });
    if (more) {
      rows.push({ kind: 'more', text: '…', y, height: ROW_H });
      y += ROW_H;
    }
    y += COMPARTMENT_PAD;
  };
  if (mode !== 'none') {
    // Members were cut by Rust (60 per list): show a dots row at the end of the methods.
    addCompartment(fields, 'field', false);
    addCompartment(methods, 'method', node.membersTruncated);
  }

  const width = Math.min(MAX_W, Math.max(MIN_W, Math.ceil(maxText + PAD_X * 2)));
  return { id: node.id, width, height: Math.max(y, HEAD_PAD_TOP + TITLE_H + HEAD_PAD_BOTTOM), rows, separators, badge };
}

/** Size of the label box of an edge. */
export function edgeLabelSize(text: string, measure: Measure): { width: number; height: number } {
  return { width: Math.ceil(measure(text, FONT_SIZE.edgeLabel, false)) + 8, height: 14 };
}

export { PAD_X, BADGE_GAP };

/** Short text for the tab title and the search list. */
export function nodeTitle(node: DiagramNode): string {
  return displayName(node);
}
