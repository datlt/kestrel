// Text export of a diagram: Mermaid `classDiagram` and PlantUML.
// Names with generics, dots or other special characters get a safe id and a quoted label.

import type { DiagramEdge, DiagramMember, DiagramNode } from '../../ipc/code';
import { kindStereotype, visibilityMark, visibleMembers } from './model';
import type { LayoutDirection, MembersMode } from './options';

export interface ExportInput {
  nodes: readonly DiagramNode[];
  edges: readonly DiagramEdge[];
  members: MembersMode;
  layout: LayoutDirection;
}

/** A name that is safe as an id in Mermaid and PlantUML: letters, digits and `_`. */
export function safeId(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (!id || /^[0-9]/.test(id)) id = `_${id}`;
  return id;
}

/** One safe and unique id for each node, in the order of `nodes`. */
export function assignIds(nodes: readonly DiagramNode[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const n of nodes) {
    const base = safeId(n.name);
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}_${i}`;
    used.add(id);
    map.set(n.id, id);
  }
  return map;
}

const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

// --- Mermaid -----------------------------------------------------------------

/** Mermaid reads `~` as the generic brackets, and breaks on braces and quotes. */
export function mermaidText(s: string): string {
  return clean(s).replace(/</g, '~').replace(/>/g, '~').replace(/[{}"]/g, '').replace(/`/g, '');
}

function mermaidMember(m: DiagramMember): string {
  const isMethod = m.kind === 'method' || m.kind === 'constructor';
  let text: string;
  if (isMethod) {
    text = `${mermaidText(m.name)}(${mermaidText(m.params)})`;
    if (m.abstract) text += '*';
    else if (m.static) text += '$';
    if (m.type) text += ` ${mermaidText(m.type)}`;
  } else {
    text = m.type ? `${mermaidText(m.name)}: ${mermaidText(m.type)}` : mermaidText(m.name);
    if (m.static) text += '$';
  }
  return `${visibilityMark(m.visibility)}${text}`;
}

const MERMAID_STEREOTYPE: Record<string, string> = { enum: 'enumeration' };

export function toMermaid(input: ExportInput): string {
  const ids = assignIds(input.nodes);
  const lines: string[] = ['classDiagram', `    direction ${input.layout === 'LR' ? 'LR' : 'TB'}`];
  for (const n of input.nodes) {
    const id = ids.get(n.id) as string;
    const generics = n.typeParams.length ? `~${n.typeParams.map(mermaidText).join(', ')}~` : '';
    const plain = id === n.name && !generics;
    const decl = plain ? `class ${id}` : generics && id === n.name ? `class ${id}${generics}` : `class ${id}["${mermaidText(n.name)}${generics ? mermaidText(`<${n.typeParams.join(', ')}>`) : ''}"]`;
    const { fields, methods } = visibleMembers(n, input.members);
    const st = kindStereotype(n);
    const body: string[] = [];
    if (st) body.push(`        <<${MERMAID_STEREOTYPE[st] ?? st}>>`);
    for (const m of fields) body.push(`        ${mermaidMember(m)}`);
    for (const m of methods) body.push(`        ${mermaidMember(m)}`);
    if (body.length) lines.push(`    ${decl} {`, ...body, '    }');
    else lines.push(`    ${decl}`);
  }
  for (const e of input.edges) {
    const a = ids.get(e.from);
    const b = ids.get(e.to);
    if (!a || !b) continue;
    const label = clean([e.label ?? '', e.delegated ? '(by)' : ''].filter(Boolean).join(' ')).replace(/[:"]/g, '');
    const mult = e.multiplicity ? ` "${e.multiplicity.replace(/"/g, '')}"` : '';
    const tail = label ? ` : ${mermaidText(label)}` : '';
    switch (e.kind) {
      case 'extends':
        lines.push(`    ${b} <|-- ${a}${tail}`);
        break;
      case 'implements':
        lines.push(`    ${b} <|.. ${a}${tail}`);
        break;
      case 'composition':
        lines.push(`    ${a} *--${mult} ${b}${tail}`);
        break;
      case 'aggregation':
        lines.push(`    ${a} o--${mult} ${b}${tail}`);
        break;
      case 'dependency':
        lines.push(`    ${a} ..> ${b}${tail}`);
        break;
      case 'nested':
        // Mermaid has no nested type symbol.
        lines.push(`    ${a} -- ${b} : nested`);
        break;
    }
  }
  return lines.join('\n') + '\n';
}

// --- PlantUML ----------------------------------------------------------------

/** PlantUML breaks on quotes and line breaks inside names and members. */
export function plantText(s: string): string {
  return clean(s).replace(/"/g, "'");
}

function plantMember(m: DiagramMember): string {
  const isMethod = m.kind === 'method' || m.kind === 'constructor';
  const mods = `${m.abstract ? '{abstract} ' : ''}${m.static ? '{static} ' : ''}`;
  let text: string;
  if (isMethod) {
    text = `${plantText(m.name)}(${plantText(m.params)})`;
    if (m.type) text += ` : ${plantText(m.type)}`;
  } else {
    text = m.type ? `${plantText(m.name)} : ${plantText(m.type)}` : plantText(m.name);
  }
  return `${mods}${visibilityMark(m.visibility)} ${text}`;
}

function plantKeyword(n: DiagramNode): { keyword: string; stereo: string | null } {
  switch (n.kind) {
    case 'interface':
    case 'protocol':
      return { keyword: 'interface', stereo: n.kind === 'protocol' ? 'protocol' : null };
    case 'enum':
      return { keyword: 'enum', stereo: null };
    case 'annotation':
      return { keyword: 'annotation', stereo: null };
    case 'class':
      return n.modifiers.includes('abstract') ? { keyword: 'abstract class', stereo: null } : { keyword: 'class', stereo: kindStereotype(n) };
    default:
      return { keyword: 'class', stereo: kindStereotype(n) };
  }
}

export function toPlantUml(input: ExportInput): string {
  const ids = assignIds(input.nodes);
  const lines: string[] = ['@startuml', 'skinparam classAttributeIconSize 0'];
  if (input.layout === 'LR') lines.push('left to right direction');
  for (const n of input.nodes) {
    const id = ids.get(n.id) as string;
    const { keyword, stereo } = plantKeyword(n);
    const generics = n.typeParams.length ? `<${plantText(n.typeParams.join(', '))}>` : '';
    const display = `${plantText(n.name)}${generics ? plantText(`<${n.typeParams.join(', ')}>`) : ''}`;
    const stereos = [stereo, ...n.annotations.slice(0, 2).map((a) => plantText(a.replace(/^@/, '').replace(/\(.*$/, '')))].filter(Boolean);
    const tag = stereos.length ? ' ' + stereos.map((s) => `<<${s}>>`).join(' ') : '';
    const { fields, methods } = visibleMembers(n, input.members);
    const head = `${keyword} "${display}" as ${id}${tag}`;
    if (fields.length + methods.length === 0) {
      lines.push(head);
      continue;
    }
    lines.push(`${head} {`);
    for (const m of fields) lines.push(`  ${plantMember(m)}`);
    if (fields.length && methods.length) lines.push('  --');
    for (const m of methods) lines.push(`  ${plantMember(m)}`);
    lines.push('}');
  }
  for (const e of input.edges) {
    const a = ids.get(e.from);
    const b = ids.get(e.to);
    if (!a || !b) continue;
    const label = plantText([e.label ?? '', e.delegated ? '(by)' : ''].filter(Boolean).join(' '));
    const mult = e.multiplicity ? ` "${e.multiplicity.replace(/"/g, '')}"` : '';
    const tail = label ? ` : ${label}` : '';
    switch (e.kind) {
      case 'extends':
        lines.push(`${b} <|-- ${a}${tail}`);
        break;
      case 'implements':
        lines.push(`${b} <|.. ${a}${tail}`);
        break;
      case 'composition':
        lines.push(`${a} *--${mult} ${b}${tail}`);
        break;
      case 'aggregation':
        lines.push(`${a} o--${mult} ${b}${tail}`);
        break;
      case 'dependency':
        lines.push(`${a} ..> ${b}${tail}`);
        break;
      case 'nested':
        lines.push(`${a} +-- ${b}`);
        break;
    }
  }
  lines.push('@enduml');
  return lines.join('\n') + '\n';
}
