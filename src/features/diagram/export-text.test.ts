import { describe, expect, it } from 'vitest';
import { assignIds, mermaidText, safeId, toMermaid, toPlantUml } from './export-text';
import { EDGES, NODES } from './fixture';

const input = { nodes: NODES, edges: EDGES, members: 'public' as const, layout: 'TB' as const };

describe('ids', () => {
  it('makes safe and unique ids', () => {
    expect(safeId('Foo')).toBe('Foo');
    expect(safeId('Weird`Name')).toBe('Weird_Name');
    expect(safeId('1st')).toBe('_1st');
    expect(safeId('')).toBe('_');
    const ids = assignIds([...NODES, { ...NODES[0], id: 'other.Repo' }]);
    expect(new Set(ids.values()).size).toBe(NODES.length + 1);
    expect(ids.get('other.Repo')).toBe('Repo_2');
  });

  it('turns generics into the Mermaid form', () => {
    expect(mermaidText('List<User>')).toBe('List~User~');
    expect(mermaidText('a {b} "c"')).toBe('a b c');
  });
});

describe('Mermaid', () => {
  const text = toMermaid(input);
  it('starts with classDiagram and writes relations in the right direction', () => {
    expect(text.startsWith('classDiagram\n')).toBe(true);
    expect(text).toContain('Repo <|.. UserRepo');
    expect(text).toContain('Base <|-- UserRepo');
    expect(text).toContain('UserRepo o-- "*" User : users');
    expect(text).toContain('User *-- "0..1" Base : base');
    expect(text).toContain('UserRepo ..> JpaRepository');
    expect(text).toContain('User -- UserRepo : nested');
  });

  it('writes stereotypes and members', () => {
    expect(text).toContain('<<interface>>');
    expect(text).toContain('<<abstract>>');
    expect(text).toContain('+find(id: ID)* T?');
    expect(text).toContain('+create()$ UserRepo');
    expect(text).not.toContain('cache'); // private, hidden in Public mode
    expect(text).not.toContain('users: List'); // private field
  });

  it('writes generics and escapes odd names', () => {
    expect(text).toContain('class Repo~T, ID~ {');
    expect(text).toContain('class Weird_Name["WeirdName~A~B~~"]');
    expect(toMermaid({ ...input, members: 'all' })).toContain('-users: List~User~');
  });
});

describe('PlantUML', () => {
  const text = toPlantUml(input);
  it('has the frame and the relations', () => {
    expect(text.startsWith('@startuml\n')).toBe(true);
    expect(text.trimEnd().endsWith('@enduml')).toBe(true);
    expect(text).toContain('Repo <|.. UserRepo');
    expect(text).toContain('Base <|-- UserRepo');
    expect(text).toContain('UserRepo o-- "*" User : users');
    expect(text).toContain('User *-- "0..1" Base : base');
    expect(text).toContain('UserRepo ..> JpaRepository');
    expect(text).toContain('User +-- UserRepo');
  });

  it('writes keywords, stereotypes, members and quoted names', () => {
    expect(text).toContain('interface "Repo<T, ID>" as Repo {');
    expect(text).toContain('abstract class "Base" as Base');
    expect(text).toContain('class "UserRepo" as UserRepo <<Service>> <<jp.x.Transactional>> {'.replace('jp.x.Transactional', 'jp.x.Transactional'));
    expect(text).toContain('{abstract} + find(id: ID) : T?');
    expect(text).toContain('{static} + create() : UserRepo');
    expect(text).toContain('class "Weird`Name<A<B>>" as Weird_Name');
  });

  it('adds the direction for left to right', () => {
    expect(toPlantUml({ ...input, layout: 'LR' })).toContain('left to right direction');
  });
});
