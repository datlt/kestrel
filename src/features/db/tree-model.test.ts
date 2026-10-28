import { describe, expect, it } from 'vitest';
import type { DbConnectionConfig, DbObject, DbObjects } from '../../ipc/db';
import {
  collectOpen,
  connectionNode,
  databaseNodes,
  expandable,
  flatten,
  groupNodes,
  isSystemSchema,
  objectNode,
  reset,
  selectTopSql,
  tableChildren,
  visibleDatabases,
} from './tree-model';

const config: DbConnectionConfig = {
  id: 'c1', name: 'Local', host: 'h', port: 3306, user: 'u', ssl: 'preferred', readOnly: false, production: false,
};
const obj = (name: string, kind: DbObject['kind'] = 'table'): DbObject => ({ name, kind, comment: null, rowsEstimate: 1234, detail: null });
const objects = (over: Partial<DbObjects> = {}): DbObjects => ({ tables: [], views: [], procedures: [], functions: [], triggers: [], ...over });

describe('system schemas', () => {
  it('hides them unless asked', () => {
    const all = ['information_schema', 'kestrel_demo', 'mysql', 'performance_schema', 'sys', 'shop'];
    expect(visibleDatabases(all, false)).toEqual(['kestrel_demo', 'shop']);
    expect(visibleDatabases(all, true)).toEqual(all);
    expect(isSystemSchema('MySQL')).toBe(true);
    expect(isSystemSchema('mysql_backup')).toBe(false);
  });
});

describe('groups', () => {
  it('shows counts and only fills groups that have objects', () => {
    const g = groupNodes('c1', 'db', objects({ tables: [obj('a'), obj('b')], views: [obj('v', 'view')] }));
    expect(g.map((n) => n.label)).toEqual(['Tables (2)', 'Views (1)', 'Procedures (0)', 'Functions (0)', 'Triggers (0)']);
    expect(expandable(g[0])).toBe(true);
    expect(expandable(g[2])).toBe(false);
    expect(g[0].children).toHaveLength(2);
  });

  it('gives tables and views a lazy column list and routines none', () => {
    expect(objectNode('c', 'd', obj('t')).children).toBeUndefined();
    expect(expandable(objectNode('c', 'd', obj('t')))).toBe(true);
    expect(objectNode('c', 'd', obj('p', 'procedure')).children).toBeNull();
    expect(expandable(objectNode('c', 'd', obj('p', 'procedure')))).toBe(false);
  });

  it('shows the row estimate and the trigger table', () => {
    expect(objectNode('c', 'd', obj('t')).detail).toBe('~1,234');
    expect(objectNode('c', 'd', { ...obj('tr', 'trigger'), detail: 'orders' }).detail).toBe('on orders');
  });
});

describe('tableChildren', () => {
  it('lists columns with type, key and nullable, then indexes', () => {
    const kids = tableChildren(
      'c', 'd', 't',
      [
        { name: 'id', type: 'int unsigned', nullable: false, key: 'PRI', default: null, extra: 'auto_increment', comment: null },
        { name: 'name', type: 'varchar(20)', nullable: true, key: '', default: null, extra: '', comment: null },
      ],
      [{ name: 'PRIMARY', unique: true, columns: ['id'], type: 'BTREE' }, { name: 'ft', unique: false, columns: ['name'], type: 'FULLTEXT' }],
    );
    expect(kids.map((k) => [k.kind, k.label, k.detail, k.tags])).toEqual([
      ['column', 'id', 'int unsigned NOT NULL', ['PRI']],
      ['column', 'name', 'varchar(20)', undefined],
      ['index', 'PRIMARY', 'id', ['UNIQUE']],
      ['index', 'ft', 'name (FULLTEXT)', undefined],
    ]);
  });
});

describe('flatten', () => {
  it('shows only open nodes, with depth', () => {
    const c = connectionNode(config);
    c.children = databaseNodes('c1', ['a', 'b']);
    expect(flatten([c])).toHaveLength(1);
    c.expanded = true;
    const rows = flatten([c]);
    expect(rows.map((r) => (r.type === 'node' ? `${r.depth}:${r.node.label}` : r.type))).toEqual(['0:Local', '1:a', '1:b']);
  });

  it('shows loading, error and empty rows', () => {
    const c = connectionNode(config);
    c.expanded = true;
    c.state = 'loading';
    expect(flatten([c])[1].type).toBe('loading');
    c.state = 'error';
    c.error = 'boom';
    expect(flatten([c])[1]).toMatchObject({ type: 'error', message: 'boom' });
    c.state = 'idle';
    c.children = [];
    expect(flatten([c])[1].type).toBe('empty');
  });

  it('handles thousands of tables', () => {
    const many = Array.from({ length: 5000 }, (_, i) => obj(`t${i}`));
    const g = groupNodes('c', 'd', objects({ tables: many }))[0];
    g.expanded = true;
    expect(flatten([g])).toHaveLength(5001);
  });
});

describe('reset and open state', () => {
  it('clears loaded children', () => {
    const c = connectionNode(config);
    c.children = databaseNodes('c1', ['a']);
    c.state = 'error';
    reset(c);
    expect(c.children).toBeUndefined();
    expect(c.state).toBe('idle');
  });
  it('collects open ids', () => {
    const c = connectionNode(config);
    c.expanded = true;
    c.children = databaseNodes('c1', ['a', 'b']);
    c.children[1].expanded = true;
    expect([...collectOpen([c])].sort()).toEqual(['c:c1', 'd:c1/b']);
  });
});

describe('selectTopSql', () => {
  it('quotes names', () => {
    expect(selectTopSql('my db', 'we`ird')).toBe('SELECT * FROM `my db`.`we``ird` LIMIT 100;');
  });
});
