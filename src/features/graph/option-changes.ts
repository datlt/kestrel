// What a change of the options needs: a new visible graph, a new layout, new
// force values, or only a redraw. Pure function.

import type { GraphOptions } from './types';

export interface OptionChange {
  /** Run `buildVisibleGraph` again. */
  rebuild: boolean;
  /** The folder colors depend on the depth: build the folder tree again. */
  tree: boolean;
  /** Send new force values to the simulation. */
  forces: boolean;
  /** The size of the nodes changed (radius for the simulation). */
  radius: boolean;
  /** The links of the tree layouts must be bent again. */
  bundles: boolean;
  /** Anything changed. */
  any: boolean;
}

const REBUILD: (keyof GraphOptions)[] = [
  'layout',
  'query',
  'showTags',
  'showAttachments',
  'existingOnly',
  'showOrphans',
  'showFolders',
  'colorBy',
  'colorDepth',
  'groups',
  'labelBy',
  'depth',
  'incoming',
  'outgoing',
  'neighborLinks',
];
const FORCES: (keyof GraphOptions)[] = ['centerForce', 'repelForce', 'linkForce', 'linkDistance', 'folderPull'];

function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function classifyOptionChange(prev: GraphOptions, next: GraphOptions): OptionChange {
  const changed = (keys: (keyof GraphOptions)[]) => keys.some((k) => differs(prev[k], next[k]));
  const rebuild = changed(REBUILD);
  const forces = changed(FORCES);
  const radius = prev.nodeSize !== next.nodeSize;
  const bundles = prev.bundling !== next.bundling;
  const display = changed(['arrows', 'textFade', 'linkThickness', 'folderOutlines']);
  return { rebuild, tree: prev.colorDepth !== next.colorDepth, forces, radius, bundles, any: rebuild || forces || radius || bundles || display };
}
