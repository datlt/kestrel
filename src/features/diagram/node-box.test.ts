import { describe, expect, it } from 'vitest';
import { member, node, NODES } from './fixture';
import { computeNodeBox, edgeLabelSize } from './node-box';
import { edgePath, resolveCssVars } from './render';

const measure = (t: string, size: number) => t.length * size * 0.55;

describe('node box', () => {
  it('has only a header without members', () => {
    const b = computeNodeBox(NODES[1], 'none', measure);
    expect(b.separators).toHaveLength(0);
    expect(b.rows.map((r) => r.kind)).toEqual(['stereotype', 'stereotype', 'title']);
    expect(b.badge?.text).toBe('Kt');
  });

  it('adds one compartment for fields and one for methods', () => {
    const n = node({ id: 'a.A', name: 'A', fields: [member({ name: 'f', kind: 'field' })], methods: [member({ name: 'm' }), member({ name: 'n' })] });
    const b = computeNodeBox(n, 'all', measure);
    expect(b.separators).toHaveLength(2);
    expect(b.rows.filter((r) => r.kind === 'method')).toHaveLength(2);
    expect(b.height).toBeGreaterThan(computeNodeBox(n, 'none', measure).height);
  });

  it('skips empty compartments and shows dots for cut-off members', () => {
    const only = node({ id: 'a.B', name: 'B', methods: [member({ name: 'm' })] });
    expect(computeNodeBox(only, 'all', measure).separators).toHaveLength(1);
    const cut = node({ id: 'a.C', name: 'C', methods: [member({ name: 'm' })], membersTruncated: true });
    expect(computeNodeBox(cut, 'all', measure).rows.some((r) => r.kind === 'more')).toBe(true);
  });

  it('is wide enough for the longest row, within limits', () => {
    const long = node({ id: 'a.D', name: 'D', methods: [member({ name: 'm', params: 'x'.repeat(50) })] });
    const small = node({ id: 'a.E', name: 'E' });
    expect(computeNodeBox(long, 'all', measure).width).toBeGreaterThan(computeNodeBox(small, 'all', measure).width);
    expect(computeNodeBox(small, 'all', measure).width).toBeGreaterThanOrEqual(96);
    expect(computeNodeBox(long, 'all', () => 5000).width).toBe(420);
  });

  it('measures edge labels', () => {
    expect(edgeLabelSize('abc', measure).width).toBeGreaterThan(8);
  });
});

describe('render helpers', () => {
  it('replaces theme variables for the SVG file', () => {
    const out = resolveCssVars('fill:var(--bg);stroke:var( --fg-muted );x:var(--nope)', (n) => (n === '--bg' ? ' #fff ' : n === '--fg-muted' ? '#888' : ''));
    expect(out).toBe('fill:#fff;stroke:#888;x:var(--nope)');
  });

  it('draws a straight line for two points and a curve for more', () => {
    expect(edgePath([{ x: 0, y: 0 }, { x: 10, y: 20 }])).toBe('M0,0 L10,20');
    const d = edgePath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 40 }]);
    expect(d.startsWith('M0,0 Q10,10 15,25 L20,40')).toBe(true);
    expect(edgePath([])).toBe('');
  });
});
