// A small hand-made diagram result for the tests. It is not real code.

import type { DiagramEdge, DiagramMember, DiagramNode, DiagramResult } from '../../ipc/code';

export function member(over: Partial<DiagramMember> & { name: string }): DiagramMember {
  return { kind: 'method', visibility: 'public', static: false, abstract: false, type: '', params: '', line: 1, column: 1, ...over };
}

export function node(over: Partial<DiagramNode> & { id: string; name: string }): DiagramNode {
  return {
    container: 'demo',
    kind: 'class',
    lang: 'kotlin',
    path: `/p/${over.name}.kt`,
    line: 3,
    column: 7,
    modifiers: [],
    annotations: [],
    typeParams: [],
    fields: [],
    methods: [],
    membersTruncated: false,
    external: false,
    ...over,
  };
}

export const NODES: DiagramNode[] = [
  node({
    id: 'demo.Repo',
    name: 'Repo',
    kind: 'interface',
    typeParams: ['T', 'ID'],
    methods: [member({ name: 'find', params: 'id: ID', type: 'T?', abstract: true }), member({ name: 'cache', visibility: 'private', params: '' })],
  }),
  node({
    id: 'demo.UserRepo',
    name: 'UserRepo',
    annotations: ['@Service("users")', '@jp.x.Transactional', '@Other'],
    fields: [member({ name: 'users', kind: 'field', visibility: 'private', type: 'List<User>' })],
    methods: [member({ name: 'find', params: 'id: Long', type: 'User?' }), member({ name: 'create', static: true, params: '', type: 'UserRepo' })],
  }),
  node({ id: 'demo.User', name: 'User', modifiers: ['data'], fields: [member({ name: 'name', kind: 'property', type: 'String' })] }),
  node({ id: 'demo.Base', name: 'Base', modifiers: ['abstract'], lang: 'java' }),
  node({ id: 'ext:JpaRepository', name: 'JpaRepository', external: true, lang: null, path: null, line: 0, column: 0 }),
  node({ id: 'demo.Weird`Name', name: 'Weird`Name', typeParams: ['A<B>'] }),
];

export const EDGES: DiagramEdge[] = [
  { from: 'demo.UserRepo', to: 'demo.Repo', kind: 'implements' },
  { from: 'demo.UserRepo', to: 'demo.Base', kind: 'extends' },
  { from: 'demo.UserRepo', to: 'demo.User', kind: 'aggregation', label: 'users', multiplicity: '*' },
  { from: 'demo.User', to: 'demo.Base', kind: 'composition', label: 'base', multiplicity: '0..1' },
  { from: 'demo.UserRepo', to: 'ext:JpaRepository', kind: 'dependency' },
  { from: 'demo.User', to: 'demo.UserRepo', kind: 'nested' },
];

export const RESULT: DiagramResult = {
  nodes: NODES,
  edges: EDGES,
  focus: ['demo.UserRepo'],
  truncated: false,
  index: { state: 'ready', files: 10, types: 6, buildMs: 5 },
};
