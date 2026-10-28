import { describe, expect, it } from 'vitest';
import { EDGES, NODES } from './fixture';
import { buildLayoutInput, edgeLabelText, isReversedKind } from './layout-input';

const size = () => ({ width: 100, height: 40 });
const label = (t: string) => ({ width: t.length * 6, height: 14 });

describe('layout input', () => {
  const input = buildLayoutInput(NODES, EDGES, size, 'TB', label);
  const edge = (i: number) => input.edges.find((e) => e.index === i)!;

  it('puts supertypes above subtypes', () => {
    // implements: UserRepo -> Repo, so dagre goes Repo -> UserRepo.
    expect(edge(0)).toMatchObject({ v: 'demo.Repo', w: 'demo.UserRepo', reversed: true });
    expect(edge(1)).toMatchObject({ v: 'demo.Base', w: 'demo.UserRepo', reversed: true });
  });

  it('puts parts, used types and nested types below the owner', () => {
    expect(edge(2)).toMatchObject({ v: 'demo.UserRepo', w: 'demo.User', reversed: false });
    expect(edge(3)).toMatchObject({ v: 'demo.User', w: 'demo.Base', reversed: false });
    expect(edge(4)).toMatchObject({ v: 'demo.UserRepo', w: 'ext:JpaRepository', reversed: false });
    expect(edge(5)).toMatchObject({ v: 'demo.User', w: 'demo.UserRepo', reversed: false });
  });

  it('reserves room for labels', () => {
    expect(edgeLabelText(EDGES[2])).toBe('users *');
    expect(edge(2).labelWidth).toBeGreaterThan(0);
    expect(edge(0).labelWidth).toBe(0);
  });

  it('skips self edges and edges to missing nodes, and sets the direction', () => {
    const i = buildLayoutInput(NODES.slice(0, 2), [{ from: 'demo.Repo', to: 'demo.Repo', kind: 'dependency' }, { from: 'demo.Repo', to: 'nope', kind: 'extends' }], size, 'LR', label);
    expect(i.edges).toHaveLength(0);
    expect(i.config.rankdir).toBe('LR');
    expect(i.nodes).toHaveLength(2);
    expect(isReversedKind('extends')).toBe(true);
    expect(isReversedKind('composition')).toBe(false);
  });
});
